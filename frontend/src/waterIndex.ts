import { bbox, booleanPointInPolygon, point } from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";

type WaterPoly = Feature<Polygon | MultiPolygon>;

export interface WaterBboxEntry {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  poly: WaterPoly;
}

/** Vector source id used for Mapbox Streets water polygons (usually `composite`). */
export function waterVectorSourceId(map: mapboxgl.Map): string | null {
  const sources = map.getStyle().sources;
  if ("composite" in sources && sources.composite.type === "vector") return "composite";
  for (const [id, src] of Object.entries(sources)) {
    if (src.type === "vector") return id;
  }
  return null;
}

/**
 * Builds a list of water polygons currently loaded in vector tiles (Mapbox Streets `water` layer).
 * Empty if the source is not ready or the style has no matching source.
 */
export function buildWaterIndex(map: mapboxgl.Map): WaterBboxEntry[] {
  if (!map.isStyleLoaded()) return [];
  const sourceId = waterVectorSourceId(map);
  if (!sourceId || !map.isSourceLoaded(sourceId)) return [];

  let raw: mapboxgl.MapboxGeoJSONFeature[];
  try {
    raw = map.querySourceFeatures(sourceId, { sourceLayer: "water" });
  } catch {
    return [];
  }

  const out: WaterBboxEntry[] = [];
  for (const f of raw) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const poly: WaterPoly = { type: "Feature", properties: {}, geometry: g };
    const b = bbox(poly);
    out.push({
      minLng: b[0],
      minLat: b[1],
      maxLng: b[2],
      maxLat: b[3],
      poly,
    });
  }
  return out;
}

export function isPointOverWater(lng: number, lat: number, index: WaterBboxEntry[]): boolean {
  if (!index.length) return false;
  const pt = point([lng, lat]);
  for (const { minLng, minLat, maxLng, maxLat, poly } of index) {
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    if (booleanPointInPolygon(pt, poly)) return true;
  }
  return false;
}
