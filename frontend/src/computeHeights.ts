import type { Feature, FeatureCollection, Polygon } from "geojson";
import { eleAtCoord, prefetchTilesForBounds } from "./elevation.ts";

const GRID_SPACING_PX = 2;
const BATCH_SIZE = 30_000;

export interface Bounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export class HeightStore {
  cells = new Map<string, Feature<Polygon>>();
  waterCells = new Set<string>();
  /** Cells where elevation lookup failed (excluded from grid like water). */
  failedCells = new Set<string>();
  lngStep = 0;
  latStep = 0;
  gridLocked = false;
  prefetchedBounds: Bounds | null = null;

  clear() {
    this.cells.clear();
    this.waterCells.clear();
    this.failedCells.clear();
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
    const { lngStep, latStep } = this;
    for (const [key, f] of this.cells) {
      const [lng, lat] = f.geometry.coordinates[0][0];
      if (lng < west || lng > east || lat < south || lat > north) {
        this.cells.delete(key);
      }
    }
    if (lngStep > 0 && latStep > 0) {
      for (const key of new Set([...this.waterCells, ...this.failedCells])) {
        const [cs, rs] = key.split("_");
        const c = Number(cs);
        const r = Number(rs);
        if (!Number.isFinite(c) || !Number.isFinite(r)) {
          this.waterCells.delete(key);
          this.failedCells.delete(key);
          continue;
        }
        const w = c * lngStep;
        const s = r * latStep;
        const e = w + lngStep;
        const n = s + latStep;
        if (e < west || w > east || n < south || s > north) {
          this.waterCells.delete(key);
          this.failedCells.delete(key);
        }
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
  store: HeightStore,
): [number, number][] {
  const colMin = Math.floor(bounds.west / lngStep);
  const colMax = Math.ceil(bounds.east / lngStep);
  const rowMin = Math.floor(bounds.south / latStep);
  const rowMax = Math.ceil(bounds.north / latStep);

  const result: [number, number][] = [];
  for (let r = rowMin; r < rowMax; r++) {
    for (let c = colMin; c < colMax; c++) {
      const key = `${c}_${r}`;
      if (!store.cells.has(key) && !store.waterCells.has(key) && !store.failedCells.has(key)) {
        result.push([c, r]);
      }
    }
  }
  return result;
}

async function ensurePrefetched(bounds: Bounds, lngStep: number, latStep: number, store: HeightStore) {
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

export interface TickResult {
  processed: number;
  remaining: number;
}

export type WaterPredicate = (lng: number, lat: number) => boolean;

/**
 * One batch of height cells (center elevation, meters). Same grid spacing as slope mode.
 */
export async function processHeightTick(
  bounds: Bounds,
  viewWidth: number,
  viewHeight: number,
  store: HeightStore,
  isOverWater?: WaterPredicate,
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
    const key = `${c}_${r}`;
    const w = c * lngStep;
    const s = r * latStep;
    const lng = w + lngStep / 2;
    const lat = s + latStep / 2;
    if (isOverWater?.(lng, lat)) {
      store.waterCells.add(key);
      continue;
    }
    const elev = await eleAtCoord(lat, lng);
    if (typeof elev !== "number" || !Number.isFinite(elev)) {
      store.failedCells.add(key);
      continue;
    }
    const e = w + lngStep;
    const n = s + latStep;
    const feature: Feature<Polygon> = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: { elev },
    };
    store.cells.set(key, feature);
  }

  return { processed: batch.length, remaining: uncomputed.length - batch.length };
}
