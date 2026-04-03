import type { Feature, FeatureCollection, Polygon } from "geojson";
import { eleAtCoord, prefetchTilesForBounds } from "./elevation.ts";

const NEIGHBOR_OFFSET_M = 8;
const GRID_SPACING_PX = 3;
const BATCH_SIZE = 30_000;

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export interface Bounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export class SlopeStore {
  cells = new Map<string, Feature<Polygon>>();
  lngStep = 0;
  latStep = 0;
  gridLocked = false;
  prefetchedBounds: Bounds | null = null;

  clear() {
    this.cells.clear();
    this.lngStep = 0;
    this.latStep = 0;
    this.gridLocked = false;
    this.prefetchedBounds = null;
  }

  prune(bounds: Bounds, margin: number) {
    const west = bounds.west - margin;
    const east = bounds.east + margin;
    const south = bounds.south - margin;
    const north = bounds.north + margin;
    for (const [key, f] of this.cells) {
      const [lng, lat] = f.geometry.coordinates[0][0];
      if (lng < west || lng > east || lat < south || lat > north) {
        this.cells.delete(key);
      }
    }
  }

  toFeatureCollection(): FeatureCollection<Polygon> {
    return { type: "FeatureCollection", features: [...this.cells.values()] };
  }
}

function computeCellSize(viewWidth: number, viewHeight: number, bounds: Bounds): [number, number] {
  const cols = Math.max(2, Math.ceil(viewWidth / GRID_SPACING_PX));
  const rows = Math.max(2, Math.ceil(viewHeight / GRID_SPACING_PX));
  return [
    (bounds.east - bounds.west) / cols,
    (bounds.north - bounds.south) / rows,
  ];
}

function getUncomputedCells(
  bounds: Bounds,
  lngStep: number,
  latStep: number,
  store: SlopeStore,
): [number, number][] {
  const colMin = Math.floor(bounds.west / lngStep);
  const colMax = Math.ceil(bounds.east / lngStep);
  const rowMin = Math.floor(bounds.south / latStep);
  const rowMax = Math.ceil(bounds.north / latStep);

  const result: [number, number][] = [];
  for (let r = rowMin; r < rowMax; r++) {
    for (let c = colMin; c < colMax; c++) {
      const key = `${c}_${r}`;
      if (!store.cells.has(key)) {
        result.push([c, r]);
      }
    }
  }
  return result;
}

async function ensurePrefetched(bounds: Bounds, lngStep: number, latStep: number, store: SlopeStore) {
  const padLng = lngStep * 2;
  const padLat = latStep * 2;
  const needed = {
    west: bounds.west - padLng,
    east: bounds.east + padLng,
    north: bounds.north + padLat,
    south: bounds.south - padLat,
  };

  const prev = store.prefetchedBounds;
  if (prev &&
    needed.west >= prev.west && needed.east <= prev.east &&
    needed.south >= prev.south && needed.north <= prev.north) {
    return;
  }

  await prefetchTilesForBounds(needed);
  store.prefetchedBounds = needed;
}

async function processCell(
  col: number, row: number,
  lngStep: number, latStep: number,
): Promise<{ feature: Feature<Polygon>; slope: number }> {
  const w = col * lngStep;
  const s = row * latStep;
  const e = w + lngStep;
  const n = s + latStep;
  const lng = (w + e) / 2;
  const lat = (s + n) / 2;

  const dLat = NEIGHBOR_OFFSET_M / METERS_PER_DEG_LAT;
  const dLon = NEIGHBOR_OFFSET_M / metersPerDegLon(lat);

  const [eleN, eleS, eleE, eleW] = await Promise.all([
    eleAtCoord(lat + dLat, lng),
    eleAtCoord(lat - dLat, lng),
    eleAtCoord(lat, lng + dLon),
    eleAtCoord(lat, lng - dLon),
  ]);

  const dzdx = (eleE - eleW) / (2 * NEIGHBOR_OFFSET_M);
  const dzdy = (eleN - eleS) / (2 * NEIGHBOR_OFFSET_M);
  const slope = Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100;

  return {
    slope,
    feature: {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: { slope },
    },
  };
}

export interface TickResult {
  processed: number;
  remaining: number;
}

/**
 * Process one batch of visible but uncomputed cells.
 * Returns how many were processed and how many remain.
 */
export async function processTick(
  bounds: Bounds,
  viewWidth: number,
  viewHeight: number,
  store: SlopeStore,
): Promise<TickResult> {
  if (!store.gridLocked) {
    const [lngStep, latStep] = computeCellSize(viewWidth, viewHeight, bounds);
    store.lngStep = lngStep;
    store.latStep = latStep;
    store.gridLocked = true;
  }

  const { lngStep, latStep } = store;

  const marginLng = (bounds.east - bounds.west);
  const marginLat = (bounds.north - bounds.south);
  store.prune(bounds, Math.max(marginLng, marginLat));

  const uncomputed = getUncomputedCells(bounds, lngStep, latStep, store);
  if (!uncomputed.length) return { processed: 0, remaining: 0 };

  await ensurePrefetched(bounds, lngStep, latStep, store);

  const batch = uncomputed.slice(0, BATCH_SIZE);

  for (const [c, r] of batch) {
    const { feature } = await processCell(c, r, lngStep, latStep);
    store.cells.set(`${c}_${r}`, feature);
  }

  return { processed: batch.length, remaining: uncomputed.length - batch.length };
}
