import { mapboxToken } from "./config.ts";

const MAX_DEM_ZOOM = 14;
const MIN_DEM_ZOOM = 5;
const TILE_SIZE = 512;
const TILESET = "mapbox.mapbox-terrain-dem-v1";

/** Clamp map zoom to a sensible DEM tile zoom (fewer tiles when zoomed out). */
export function demZoomForMapZoom(mapZoom: number): number {
  return Math.min(MAX_DEM_ZOOM, Math.max(MIN_DEM_ZOOM, Math.round(mapZoom)));
}

const tileCache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

function coordToTile(lat: number, lon: number, zoom: number): [number, number] {
  const latRad = (lat * Math.PI) / 180;
  const n = 1 << zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [x, y];
}

function tileToCoord(x: number, y: number, zoom: number): [number, number] {
  const n = 1 << zoom;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lat, lon];
}

async function fetchHeightmap(tx: number, ty: number, tz: number): Promise<Float32Array> {
  const key = `${tx}/${ty}/${tz}`;
  if (tileCache.has(key)) return tileCache.get(key)!;
  if (inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    const url = `https://api.mapbox.com/v4/${TILESET}/${tz}/${tx}/${ty}@2x.pngraw?access_token=${mapboxToken}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`DEM fetch failed: ${resp.status}`);

    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
    const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);

    const heightmap = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      heightmap[i] = -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
    }

    tileCache.set(key, heightmap);
    return heightmap;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export async function eleAtCoord(lat: number, lon: number, demZoom: number = MAX_DEM_ZOOM): Promise<number> {
  const [tx, ty] = coordToTile(lat, lon, demZoom);
  const heightmap = await fetchHeightmap(tx, ty, demZoom);

  const [tlLat, tlLon] = tileToCoord(tx, ty, demZoom);
  const [brLat, brLon] = tileToCoord(tx + 1, ty + 1, demZoom);

  let xPx = ((lon - tlLon) / (brLon - tlLon)) * TILE_SIZE;
  let yPx = ((lat - tlLat) / (brLat - tlLat)) * TILE_SIZE;
  xPx = Math.min(xPx, TILE_SIZE - 0.01);
  yPx = Math.min(yPx, TILE_SIZE - 0.01);

  const x0 = Math.floor(xPx);
  const y0 = Math.floor(yPx);
  const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
  const y1 = Math.min(y0 + 1, TILE_SIZE - 1);

  const tl = heightmap[y0 * TILE_SIZE + x0];
  const tr = heightmap[y0 * TILE_SIZE + x1];
  const bl = heightmap[y1 * TILE_SIZE + x0];
  const br = heightmap[y1 * TILE_SIZE + x1];

  const fx = xPx - x0;
  const fy = yPx - y0;
  return lerp(lerp(tl, tr, fx), lerp(bl, br, fx), fy);
}

export async function prefetchTilesForBounds(
  bounds: { west: number; east: number; north: number; south: number },
  demZoom: number = MAX_DEM_ZOOM,
): Promise<void> {
  const [minTx, minTy] = coordToTile(bounds.north, bounds.west, demZoom);
  const [maxTx, maxTy] = coordToTile(bounds.south, bounds.east, demZoom);

  const promises: Promise<Float32Array>[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      promises.push(fetchHeightmap(tx, ty, demZoom));
    }
  }
  await Promise.all(promises);
}
