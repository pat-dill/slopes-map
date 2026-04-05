import * as turf from "@turf/turf";
import type { Map as MapboxMap } from "mapbox-gl";
import type { Feature, FeatureCollection, LineString } from "geojson";
import { eleAtCoord, prefetchTilesForBounds } from "./elevation.ts";

const MAX_SEGMENT_METERS = 30;
const MIN_SEGMENT_METERS = 15;
const ROAD_QUERY_SOURCE = "streets-v8";
const FLUSH_INTERVAL = 25;

const BIKEABLE_CLASSES = new Set([
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "street", "street_limited",
  "pedestrian",
  "path",
]);

const ALLOWED_PATH_TYPES = new Set(["cycleway", "path"]);

function roadKey(f: Feature<LineString>): string {
  const coords = f.geometry.coordinates;
  return `${coords[0][0]},${coords[0][1]}-${coords[coords.length - 1][0]},${coords[coords.length - 1][1]}-${coords.length}`;
}

function deduplicateFeatures(features: Feature<LineString>[]): Feature<LineString>[] {
  const seen = new Set<string>();
  const result: Feature<LineString>[] = [];
  for (const f of features) {
    const key = roadKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(f);
  }
  return result;
}

function getRoadFeatures(map: MapboxMap): Feature<LineString>[] {
  if (!map.getSource(ROAD_QUERY_SOURCE)) return [];

  const features = map.querySourceFeatures(ROAD_QUERY_SOURCE, {
    sourceLayer: "road",
  });

  const lines: Feature<LineString>[] = [];
  for (const f of features) {
    const cls = f.properties?.class as string | undefined;
    if (!cls || !BIKEABLE_CLASSES.has(cls)) continue;
    if (cls === "path" && !ALLOWED_PATH_TYPES.has(f.properties?.type as string)) continue;

    const structure = f.properties?.structure as string | undefined;
    if (structure === "bridge" || structure === "tunnel") continue;

    if (f.geometry?.type === "LineString") {
      lines.push(f as unknown as Feature<LineString>);
    } else if (f.geometry?.type === "MultiLineString") {
      for (const coords of (f.geometry as any).coordinates) {
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: f.properties,
        });
      }
    }
  }

  return deduplicateFeatures(lines);
}

export class GradientStore {
  segments: Feature<LineString>[] = [];
  processedRoads = new Set<string>();

  toFeatureCollection(): FeatureCollection<LineString> {
    return { type: "FeatureCollection", features: this.segments };
  }
}

function mergeShortChunks(
  chunks: Feature<LineString>[],
): Feature<LineString>[] {
  if (chunks.length <= 1) return chunks;

  const result: Feature<LineString>[] = [];
  for (const chunk of chunks) {
    const len = turf.length(chunk, { units: "meters" });
    if (len >= MIN_SEGMENT_METERS || result.length === 0) {
      result.push(chunk);
    } else {
      const prev = result[result.length - 1];
      const merged = prev.geometry.coordinates.slice();
      for (const coord of chunk.geometry.coordinates.slice(1)) {
        merged.push(coord);
      }
      result[result.length - 1] = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: merged },
        properties: prev.properties,
      };
    }
  }
  return result;
}

export interface GradientCallbacks {
  onProgress?: (processed: number, total: number) => void;
  onFlush?: (fc: FeatureCollection<LineString>) => void;
}

export async function computeGradients(
  map: MapboxMap,
  store: GradientStore,
  callbacks?: GradientCallbacks,
): Promise<void> {
  const allRoads = getRoadFeatures(map);
  const newRoads = allRoads.filter((r) => !store.processedRoads.has(roadKey(r)));

  if (!newRoads.length) {
    callbacks?.onFlush?.(store.toFeatureCollection());
    return;
  }

  callbacks?.onProgress?.(0, newRoads.length);

  const bounds = map.getBounds()!;
  await prefetchTilesForBounds({
    west: bounds.getWest(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
    south: bounds.getSouth(),
  });

  let lastFlush = 0;

  function flush() {
    callbacks?.onFlush?.(store.toFeatureCollection());
  }

  for (let ri = 0; ri < newRoads.length; ri++) {
    const road = newRoads[ri];
    store.processedRoads.add(roadKey(road));

    const len = turf.length(road, { units: "meters" });
    if (len < MIN_SEGMENT_METERS) continue;

    const rawChunks =
      len > MAX_SEGMENT_METERS
        ? turf.lineChunk(road, MAX_SEGMENT_METERS, { units: "meters" }).features
        : [road];

    const chunks = mergeShortChunks(rawChunks);

    for (const chunk of chunks) {
      const coords = chunk.geometry.coordinates;
      const start = coords[0];
      const end = coords[coords.length - 1];

      const [eleStart, eleEnd] = await Promise.all([
        eleAtCoord(start[1], start[0]),
        eleAtCoord(end[1], end[0]),
      ]);

      const segLen = turf.length(chunk, { units: "meters" });
      const grade = segLen > 0 ? (Math.abs(eleEnd - eleStart) / segLen) * 100 : 0;

      store.segments.push({
        type: "Feature",
        geometry: chunk.geometry,
        properties: { grade },
      });
    }

    if (ri - lastFlush >= FLUSH_INTERVAL) {
      lastFlush = ri;
      callbacks?.onProgress?.(ri + 1, newRoads.length);
      flush();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  callbacks?.onProgress?.(newRoads.length, newRoads.length);
  flush();
}
