import './App.css'
import Map from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import type { ExpressionSpecification } from "mapbox-gl";
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxToken } from "./config.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeGradients, GradientStore } from "./computeGradients.ts";
import { processTick, SlopeStore } from "./computeSlopes.ts";
import { processHeightTick, HeightStore } from "./computeHeights.ts";
import { buildWaterIndex, isPointOverWater, waterVectorSourceId } from "./waterIndex.ts";
import { eleAtCoord, prefetchTilesForBounds } from "./elevation.ts";
import { LockOutlined, UnlockOutlined } from "@ant-design/icons";
import { Button, Progress, Segmented } from "antd";

type ViewMode = "roads" | "terrain" | "heightmap";

const MAP_STYLE_ROADS = "mapbox://styles/paricdil/cme3ipbul01pr01s24ymeep2j";
const MAP_STYLE_TERRAIN = "mapbox://styles/mapbox/dark-v11";

const GRADIENT_SOURCE = "gradient-data";
const GRADIENT_LAYER = "gradient-lines";
const ROAD_QUERY_SOURCE = "streets-v8";
const ROAD_LOADER_LAYER = "road-loader";

const SLOPE_SOURCE = "slope-data";
const SLOPE_LAYER = "slope-fill";

const HEIGHT_SOURCE = "height-data";
const HEIGHT_LAYER = "height-fill";

/** Visible elevation range for heightmap coloring (robust to outliers). */
const HEIGHTMAP_LOW_PERCENTILE = 0.003;
const HEIGHTMAP_HIGH_PERCENTILE = 0.997;
/** Coarse grid to set color scale before filling the full height field after map moves. */
const HEIGHTMAP_PREGRID = 20;

const COLORS = ["#00ff00", "#ffff00", "#ff0000", "#ff00ff", "#ffffff"];
const HIGH_PERCENTILE = 0.985;

/** Road grade scale (percent). */
const MAX_GRADE_SCALE = 25;
const GRADE_STOP_PERCENTILES = [0, 0.4, 0.667, 0.9, HIGH_PERCENTILE] as const;

/** Terrain slope scale (percent grade equivalent). */
const MAX_SLOPE_SCALE = 100;
const SLOPE_STOP_PERCENTILES = [0, 0.3, 0.6, 0.9, HIGH_PERCENTILE] as const;

const MIN_RENDER_ZOOM_SLOPE = 9;
const ZOOM_SETTLE_MS = 400;

const INITIAL_STOPS: number[] = [0, 5, 10, 15, 20];

/** Meters above mean sea level → feet (international foot). */
const M_TO_FT = 3.280839895013123;

function percentileOfSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const x = p * (n - 1);
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  const a = sorted[lo]!;
  if (lo === hi) return a;
  const b = sorted[hi]!;
  return a + (b - a) * (x - lo);
}

/**
 * Sample a coarse grid across the viewport, then P_low / P_high of those elevations
 * so the palette matches the scene before dense cells are computed.
 */
async function sampleHeightmapPercentileRange(
  bounds: { west: number; east: number; north: number; south: number },
  isOverWater: (lng: number, lat: number) => boolean,
): Promise<{ lowM: number; highM: number } | null> {
  const { west, east, north, south } = bounds;
  await prefetchTilesForBounds(bounds);
  const g = HEIGHTMAP_PREGRID;
  const latLngs: { lat: number; lng: number }[] = [];
  for (let j = 0; j < g; j++) {
    const lat = south + (north - south) * (j + 0.5) / g;
    for (let i = 0; i < g; i++) {
      const lng = west + (east - west) * (i + 0.5) / g;
      if (!isOverWater(lng, lat)) latLngs.push({ lat, lng });
    }
  }
  const elevs = await Promise.all(latLngs.map(({ lat, lng }) => eleAtCoord(lat, lng)));
  const samples: number[] = [];
  for (const e of elevs) {
    if (typeof e === "number" && Number.isFinite(e)) samples.push(e);
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a - b);
  let lowM = percentileOfSorted(samples, HEIGHTMAP_LOW_PERCENTILE);
  let highM = percentileOfSorted(samples, HEIGHTMAP_HIGH_PERCENTILE);
  if (highM <= lowM) highM = lowM + 1e-3;
  return { lowM, highM };
}

function buildGradeColorExpression(stops: readonly number[]) {
  const pairs = COLORS.flatMap((color, i) => [stops[i]!, color]);
  return ["interpolate", ["linear"], ["get", "grade"], ...pairs];
}

function buildSlopeFillColor(stops: readonly number[]) {
  const pairs = COLORS.flatMap((color, i) => [stops[i]!, color]);
  return ["interpolate", ["linear"], ["get", "slope"], ...pairs];
}

/** Same palette as slopes; stops evenly spaced between `lowM` and `highM` (m). */
function buildHeightmapFillColor(lowM: number, highM: number): ExpressionSpecification {
  const lo = lowM;
  const hi = Math.max(highM, lowM + 1e-3);
  const span = hi - lo;
  const n = COLORS.length;
  const pairs = COLORS.flatMap((color, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const v = lo + span * t;
    return [v, color];
  });
  return [
    "interpolate",
    ["linear"],
    ["max", lo, ["min", hi, ["to-number", ["get", "elev"]]]],
    ...pairs,
  ] as ExpressionSpecification;
}

function ensureRoadSource(map: mapboxgl.Map) {
  if (!map.getSource(ROAD_QUERY_SOURCE)) {
    map.addSource(ROAD_QUERY_SOURCE, {
      type: "vector",
      url: "mapbox://mapbox.mapbox-streets-v8",
    });
  }
  if (!map.getLayer(ROAD_LOADER_LAYER)) {
    map.addLayer({
      id: ROAD_LOADER_LAYER,
      type: "line",
      source: ROAD_QUERY_SOURCE,
      "source-layer": "road",
      paint: { "line-opacity": 0.01, "line-width": 0.5 },
    });
  }
}

const MAPBOX_DEM_SOURCE_ID = "mapbox-dem";

function ensureMapboxDemSource(map: mapboxgl.Map) {
  if (map.getSource(MAPBOX_DEM_SOURCE_ID)) return;
  map.addSource(MAPBOX_DEM_SOURCE_ID, {
    type: "raster-dem",
    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14,
  });
}

/** First style layer (bottom-up order) that should paint above the slope: roads, bridges, tunnels, buildings. */
function findFirstLayerAboveSlope(map: mapboxgl.Map): string | undefined {
  for (const layer of map.getStyle().layers) {
    const id = layer.id;
    if (
      id.startsWith("road") ||
      id.startsWith("tunnel") ||
      id.startsWith("bridge") ||
      id.startsWith("building")
    ) {
      return id;
    }
  }
  return undefined;
}

function ensureGradientLayer(map: mapboxgl.Map, gradeStops: readonly number[]) {
  if (!map.getSource(GRADIENT_SOURCE)) {
    map.addSource(GRADIENT_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(GRADIENT_LAYER)) {
    map.addLayer({
      id: GRADIENT_LAYER,
      type: "line",
      source: GRADIENT_SOURCE,
      minzoom: 12,
      paint: {
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          10, 1, 12, 2, 15, 5, 16, 5, 20, 10,
        ],
        "line-color": buildGradeColorExpression(gradeStops) as ExpressionSpecification,
        "line-emissive-strength": 0.8,
        "line-opacity": 0.8,
      },
    });
  }
}

function ensureSlopeLayer(map: mapboxgl.Map, slopeStops: readonly number[]) {
  if (!map.getSource(SLOPE_SOURCE)) {
    map.addSource(SLOPE_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(SLOPE_LAYER)) {
    const beforeId = findFirstLayerAboveSlope(map);
    map.addLayer({
      id: SLOPE_LAYER,
      type: "fill",
      source: SLOPE_SOURCE,
      paint: {
        "fill-color": buildSlopeFillColor(slopeStops) as ExpressionSpecification,
        "fill-opacity": 0.9,
        "fill-antialias": false,
      },
    }, beforeId);
  }
}

function ensureHeightmapLayer(map: mapboxgl.Map, lowM: number, highM: number) {
  if (!map.getSource(HEIGHT_SOURCE)) {
    map.addSource(HEIGHT_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(HEIGHT_LAYER)) {
    const beforeId = findFirstLayerAboveSlope(map);
    map.addLayer({
      id: HEIGHT_LAYER,
      type: "fill",
      source: HEIGHT_SOURCE,
      paint: {
        "fill-color": buildHeightmapFillColor(lowM, highM),
        "fill-opacity": 0.92,
        "fill-antialias": false,
      },
    }, beforeId);
  }
}

function roundZoom(z: number): number {
  return Math.round(z * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type HoverElevation =
  | { ok: true; meters: number }
  /** `pending`: fetching DEM via API (Mapbox often returns null from queryTerrainElevation until GPU tiles load). */
  | { ok: false; pending?: boolean };

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("roads");
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const [gradeStops, setGradeStops] = useState<number[]>(INITIAL_STOPS);
  const [slopeStops, setSlopeStops] = useState<number[]>(INITIAL_STOPS);
  const gradeStopsRef = useRef(gradeStops);
  gradeStopsRef.current = gradeStops;
  const slopeStopsRef = useRef(slopeStops);
  slopeStopsRef.current = slopeStops;

  const [stopsLocked, setStopsLocked] = useState(false);
  const stopsLockedRef = useRef(stopsLocked);
  stopsLockedRef.current = stopsLocked;

  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  /** Heightmap color scale bounds (meters), auto from P1–P99 of on-screen cells unless locked. */
  const [heightRange, setHeightRange] = useState<{ lowM: number; highM: number }>({
    lowM: 0,
    highM: 2000,
  });
  const heightRangeRef = useRef(heightRange);
  heightRangeRef.current = heightRange;
  /** Run 10×10 presample to set `heightRange` after a reset, before dense `processHeightTick`. */
  const heightGridPrescaleNeededRef = useRef(true);
  const [hoverElevation, setHoverElevation] = useState<HoverElevation | null>(null);

  const mapRef = useRef<MapRef>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const computingRef = useRef(false);
  const readyRef = useRef(false);
  const gradientStoreRef = useRef(new GradientStore());
  const slopeStoreRef = useRef(new SlopeStore());
  const heightStoreRef = useRef(new HeightStore());
  const hoverElevSeqRef = useRef(0);
  const hoverElevDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Avoid duplicate `styledata` listeners if `onLoad` runs more than once for the same map instance. */
  const mapInstanceForTerrainRef = useRef<mapboxgl.Map | null>(null);

  const mapStyle =
    viewMode === "roads" ? MAP_STYLE_ROADS : MAP_STYLE_TERRAIN;

  /** react-map-gl skips `setTerrain` when the DEM source is missing; ensure source after every style load. */
  const applyTerrainForViewMode = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;
    if (viewModeRef.current === "terrain" || viewModeRef.current === "heightmap") {
      ensureMapboxDemSource(map);
      map.setTerrain({ source: MAPBOX_DEM_SOURCE_ID, exaggeration: 1 });
    } else {
      map.setTerrain(null);
    }
  }, []);

  const gradeColorExpr = useMemo(() => buildGradeColorExpression(gradeStops), [gradeStops]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (map && map.getLayer(GRADIENT_LAYER)) {
      map.setPaintProperty(GRADIENT_LAYER, "line-color", gradeColorExpr as ExpressionSpecification);
    }
  }, [gradeColorExpr]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer(SLOPE_LAYER)) return;
    map.setPaintProperty(SLOPE_LAYER, "fill-color", buildSlopeFillColor(slopeStops) as ExpressionSpecification);
  }, [slopeStops]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer(HEIGHT_LAYER)) return;
    map.setPaintProperty(
      HEIGHT_LAYER,
      "fill-color",
      buildHeightmapFillColor(heightRange.lowM, heightRange.highM),
    );
  }, [heightRange]);

  useEffect(() => {
    if (viewMode !== "roads") {
      const map = mapRef.current?.getMap();
      const src = map?.getSource(GRADIENT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
      gradientStoreRef.current = new GradientStore();
      setProgress(null);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "terrain") {
      const map = mapRef.current?.getMap();
      const src = map?.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
      slopeStoreRef.current = new SlopeStore();
      setRemaining(null);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "heightmap") {
      const map = mapRef.current?.getMap();
      const src = map?.getSource(HEIGHT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
      heightStoreRef.current = new HeightStore();
      setRemaining(null);
      setHeightRange({ lowM: 0, highM: 2000 });
    } else {
      heightGridPrescaleNeededRef.current = true;
    }
  }, [viewMode]);

  useEffect(() => {
    applyTerrainForViewMode();
  }, [viewMode, applyTerrainForViewMode]);

  const onMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    if (mapInstanceForTerrainRef.current !== map) {
      mapInstanceForTerrainRef.current = map;
      map.on("styledata", () => applyTerrainForViewMode());
    }

    if (viewModeRef.current === "roads") {
      ensureRoadSource(map);
    }
    applyTerrainForViewMode();
    readyRef.current = true;
  }, [applyTerrainForViewMode]);

  const updateGradients = useCallback(() => {
    if (viewModeRef.current !== "roads" || !readyRef.current || computingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const map = mapRef.current?.getMap();
      if (!map || !map.isStyleLoaded()) return;
      if (map.getZoom() < 11) return;

      ensureRoadSource(map);
      ensureGradientLayer(map, gradeStopsRef.current);

      computingRef.current = true;
      const src = map.getSource(GRADIENT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      const store = gradientStoreRef.current;

      try {
        await computeGradients(map, store, {
          onProgress(processed, total) {
            setProgress({ processed, total });
          },
          onFlush(fc) {
            if (src) src.setData(fc);
          },
        });
        setProgress(null);

        const bounds = map.getBounds()!;
        const grades: number[] = [];
        for (const f of store.segments) {
          const grade = f.properties?.grade;
          if (typeof grade !== "number" || grade <= 0) continue;
          const c = f.geometry.coordinates[0];
          if (c[0] >= bounds.getWest() && c[0] <= bounds.getEast() &&
            c[1] >= bounds.getSouth() && c[1] <= bounds.getNorth()) {
            grades.push(grade);
          }
        }
        if (!grades.length) return;

        grades.sort((a, b) => a - b);
        const next = GRADE_STOP_PERCENTILES.map((p) =>
          Math.min(MAX_GRADE_SCALE, Math.max(0, percentileOfSorted(grades, p))),
        );
        for (let i = 1; i < next.length; i++) {
          if (next[i]! < next[i - 1]!) next[i] = next[i - 1]!;
        }
        if (!stopsLockedRef.current) setGradeStops(next);
      } finally {
        computingRef.current = false;
      }
    }, 300);
  }, []);

  useEffect(() => {
    if (viewMode === "roads") {
      updateGradients();
    }
  }, [viewMode, updateGradients]);

  useEffect(() => {
    let alive = true;
    let lastZoom: number | null = null;
    let zoomChangedAt = 0;

    async function loop() {
      while (alive) {
        if (viewModeRef.current !== "terrain") {
          await sleep(200);
          continue;
        }

        const map = mapRef.current?.getMap();
        if (!map || !map.isStyleLoaded()) {
          await sleep(200);
          continue;
        }

        const zoom = roundZoom(map.getZoom());

        if (zoom < MIN_RENDER_ZOOM_SLOPE) {
          if (lastZoom === null || lastZoom >= MIN_RENDER_ZOOM_SLOPE) {
            slopeStoreRef.current = new SlopeStore();
            const src = map.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
            if (src) src.setData({ type: "FeatureCollection", features: [] });
            setRemaining(null);
          }
          lastZoom = zoom;
          await sleep(200);
          continue;
        }

        if (lastZoom !== null && zoom !== lastZoom) {
          slopeStoreRef.current = new SlopeStore();
          zoomChangedAt = Date.now();
          const src = map.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData({ type: "FeatureCollection", features: [] });
        }
        lastZoom = zoom;

        if (Date.now() - zoomChangedAt < ZOOM_SETTLE_MS) {
          await sleep(50);
          continue;
        }

        ensureSlopeLayer(map, slopeStopsRef.current);

        const bounds = map.getBounds()!;
        const canvas = map.getCanvas();
        const store = slopeStoreRef.current;

        const vectorId = waterVectorSourceId(map);
        if (vectorId && !map.isSourceLoaded(vectorId)) {
          await sleep(100);
          continue;
        }

        const waterIndex = buildWaterIndex(map);
        const isOverWater = (lng: number, lat: number) =>
          isPointOverWater(lng, lat, waterIndex);

        const { processed, remaining: rem } = await processTick(
          {
            west: bounds.getWest(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
            south: bounds.getSouth(),
          },
          canvas.width / devicePixelRatio,
          canvas.height / devicePixelRatio,
          store,
          isOverWater,
        );

        if (processed > 0) {
          const src = map.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData(store.toFeatureCollection());
          setRemaining(rem);

          if (rem === 0) {
            updateSlopeScale(store, bounds);
          }
        } else {
          setRemaining(null);
          await sleep(150);
        }

        await sleep(0);
      }
    }

    function updateSlopeScale(store: SlopeStore, bounds: mapboxgl.LngLatBounds) {
      const visibleSlopes: number[] = [];
      for (const f of store.cells.values()) {
        const s = f.properties?.slope;
        if (typeof s !== "number" || s <= 0) continue;
        const coord = f.geometry.coordinates[0][0];
        if (coord[0] >= bounds.getWest() && coord[0] <= bounds.getEast() &&
          coord[1] >= bounds.getSouth() && coord[1] <= bounds.getNorth()) {
          visibleSlopes.push(s);
        }
      }
      if (!visibleSlopes.length) return;
      visibleSlopes.sort((a, b) => a - b);
      const next = SLOPE_STOP_PERCENTILES.map((p) =>
        Math.min(MAX_SLOPE_SCALE, Math.max(0, percentileOfSorted(visibleSlopes, p))),
      );
      for (let i = 1; i < next.length; i++) {
        if (next[i]! < next[i - 1]!) next[i] = next[i - 1]!;
      }
      if (!stopsLockedRef.current) setSlopeStops(next);
    }

    loop();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    let lastZoom: number | null = null;
    let zoomChangedAt = 0;

    async function loop() {
      while (alive) {
        if (viewModeRef.current !== "heightmap") {
          await sleep(200);
          continue;
        }

        const map = mapRef.current?.getMap();
        if (!map || !map.isStyleLoaded()) {
          await sleep(200);
          continue;
        }

        const zoom = roundZoom(map.getZoom());

        if (zoom < MIN_RENDER_ZOOM_SLOPE) {
          if (lastZoom === null || lastZoom >= MIN_RENDER_ZOOM_SLOPE) {
            heightStoreRef.current = new HeightStore();
            heightGridPrescaleNeededRef.current = true;
            const src = map.getSource(HEIGHT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
            if (src) src.setData({ type: "FeatureCollection", features: [] });
            setRemaining(null);
          }
          lastZoom = zoom;
          await sleep(200);
          continue;
        }

        if (lastZoom !== null && zoom !== lastZoom) {
          heightStoreRef.current = new HeightStore();
          heightGridPrescaleNeededRef.current = true;
          zoomChangedAt = Date.now();
          const src = map.getSource(HEIGHT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData({ type: "FeatureCollection", features: [] });
        }
        lastZoom = zoom;

        if (Date.now() - zoomChangedAt < ZOOM_SETTLE_MS) {
          await sleep(50);
          continue;
        }

        const bounds = map.getBounds()!;
        const vectorId = waterVectorSourceId(map);
        if (vectorId && !map.isSourceLoaded(vectorId)) {
          await sleep(100);
          continue;
        }

        const waterIndex = buildWaterIndex(map);
        const isOverWater = (lng: number, lat: number) =>
          isPointOverWater(lng, lat, waterIndex);

        if (heightGridPrescaleNeededRef.current) {
          try {
            const sampled = await sampleHeightmapPercentileRange(
              {
                west: bounds.getWest(),
                east: bounds.getEast(),
                north: bounds.getNorth(),
                south: bounds.getSouth(),
              },
              isOverWater,
            );
            if (sampled && !stopsLockedRef.current) {
              setHeightRange(sampled);
              heightRangeRef.current = sampled;
            }
          } catch {
            /* keep prior range; dense grid will still try */
          } finally {
            heightGridPrescaleNeededRef.current = false;
          }
        }

        const { lowM, highM } = heightRangeRef.current;
        ensureHeightmapLayer(map, lowM, highM);

        const canvas = map.getCanvas();
        const store = heightStoreRef.current;

        const { processed, remaining: rem } = await processHeightTick(
          {
            west: bounds.getWest(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
            south: bounds.getSouth(),
          },
          canvas.width / devicePixelRatio,
          canvas.height / devicePixelRatio,
          store,
          isOverWater,
        );

        if (processed > 0) {
          const src = map.getSource(HEIGHT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData(store.toFeatureCollection());
          setRemaining(rem);

          if (rem === 0) {
            updateHeightRangeFromPercentiles(store, bounds);
          }
        } else {
          setRemaining(null);
          await sleep(150);
        }

        await sleep(0);
      }
    }

    function updateHeightRangeFromPercentiles(store: HeightStore, bounds: mapboxgl.LngLatBounds) {
      const visibleElev: number[] = [];
      for (const f of store.cells.values()) {
        const e = f.properties?.elev;
        if (typeof e !== "number" || !Number.isFinite(e)) continue;
        const coord = f.geometry.coordinates[0][0];
        if (coord[0] >= bounds.getWest() && coord[0] <= bounds.getEast() &&
          coord[1] >= bounds.getSouth() && coord[1] <= bounds.getNorth()) {
          visibleElev.push(e);
        }
      }
      if (visibleElev.length < 2) return;
      visibleElev.sort((a, b) => a - b);
      let lowM = percentileOfSorted(visibleElev, HEIGHTMAP_LOW_PERCENTILE);
      let highM = percentileOfSorted(visibleElev, HEIGHTMAP_HIGH_PERCENTILE);
      if (highM <= lowM) highM = lowM + 1e-3;
      if (!stopsLockedRef.current) setHeightRange({ lowM, highM });
    }

    loop();
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    if (hoverElevDebounceRef.current) clearTimeout(hoverElevDebounceRef.current);
  }, []);

  const HOVER_DEM_DEBOUNCE_MS = 55;

  const onMapMouseMove = useCallback((e: mapboxgl.MapLayerMouseEvent) => {
    const map = mapRef.current?.getMap();
    const { lngLat } = e;
    const lat = lngLat.lat;
    const lng = lngLat.lng;

    const syncM = map?.queryTerrainElevation(lngLat);
    if (typeof syncM === "number") {
      if (hoverElevDebounceRef.current) {
        clearTimeout(hoverElevDebounceRef.current);
        hoverElevDebounceRef.current = null;
      }
      hoverElevSeqRef.current += 1;
      setHoverElevation({ ok: true, meters: syncM });
      return;
    }

    if (hoverElevDebounceRef.current) clearTimeout(hoverElevDebounceRef.current);

    const seq = ++hoverElevSeqRef.current;
    setHoverElevation({ ok: false, pending: true });

    hoverElevDebounceRef.current = setTimeout(() => {
      hoverElevDebounceRef.current = null;
      eleAtCoord(lat, lng).then((m) => {
        if (seq !== hoverElevSeqRef.current) return;
        if (typeof m === "number" && Number.isFinite(m)) {
          setHoverElevation({ ok: true, meters: m });
        } else {
          setHoverElevation({ ok: false });
        }
      }).catch(() => {
        if (seq !== hoverElevSeqRef.current) return;
        setHoverElevation({ ok: false });
      });
    }, HOVER_DEM_DEBOUNCE_MS);
  }, []);

  const onMapMouseOut = useCallback(() => {
    if (hoverElevDebounceRef.current) {
      clearTimeout(hoverElevDebounceRef.current);
      hoverElevDebounceRef.current = null;
    }
    hoverElevSeqRef.current += 1;
    setHoverElevation(null);
  }, []);

  const pct = progress
    ? Math.round((progress.processed / progress.total) * 100)
    : null;

  const legendStops = viewMode === "roads" ? gradeStops : slopeStops;
  const legendTitle =
    viewMode === "roads" ? "Grade" : viewMode === "terrain" ? "Slope" : "Elevation";

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{
          longitude: -122.4,
          latitude: 37.8,
          zoom: 14,
        }}
        style={{ width: "100%", height: "100%" }}
        projection="globe"
        mapStyle={mapStyle}
        terrain={
          viewMode === "terrain" || viewMode === "heightmap"
            ? { source: MAPBOX_DEM_SOURCE_ID, exaggeration: 1 }
            : undefined
        }
        onLoad={onMapLoad}
        onIdle={updateGradients}
        onMouseMove={onMapMouseMove}
        onMouseOut={onMapMouseOut}
      />

      <div style={{
        position: "fixed",
        left: 16,
        top: 16,
        zIndex: 10,
        background: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(12px)",
        borderRadius: 10,
        padding: 6,
      }}>
        <Segmented<ViewMode>
          value={viewMode}
          onChange={(v) => setViewMode(v)}
          options={[
            { label: "Roads", value: "roads" },
            { label: "Terrain", value: "terrain" },
            { label: "Heightmap", value: "heightmap" },
          ]}
        />
      </div>

      <div style={{
        position: "fixed",
        right: 16,
        top: "50%",
        transform: "translateY(-50%)",
        background: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(12px)",
        borderRadius: 10,
        padding: "12px 14px",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: "#ffffff99",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}>
          <span>{legendTitle}</span>
          <Button
            type="text"
            size="small"
            icon={stopsLocked ? <LockOutlined /> : <UnlockOutlined />}
            onClick={() => setStopsLocked((v) => !v)}
            aria-label={stopsLocked ? "Unlock color stops" : "Lock color stops"}
            title={
              stopsLocked
                ? "Unlock to resume auto scale"
                : viewMode === "heightmap"
                  ? "Lock elevation range (P1–P99)"
                  : "Lock color stops"
            }
            style={{
              color: stopsLocked ? "#ffb020" : "#ffffffaa",
              padding: 0,
              width: 22,
              height: 22,
              minWidth: 22,
              lineHeight: 1,
            }}
          />
        </div>
        <div style={{
          display: "flex",
          alignItems: "stretch",
          gap: 10,
        }}>
          {viewMode === "heightmap" ? (
            <>
              <div style={{
                width: 14,
                height: 160,
                borderRadius: 7,
                flexShrink: 0,
                background: `linear-gradient(to top, ${COLORS.join(", ")})`,
              }} />
              <div style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                height: 160,
              }}>
                {Array.from({ length: COLORS.length }, (_, i) => {
                  const spanM = Math.max(heightRange.highM - heightRange.lowM, 1e-3);
                  const t = (COLORS.length - 1 - i) / (COLORS.length - 1);
                  const m = heightRange.lowM + spanM * t;
                  return (
                    <span
                      key={i}
                      style={{
                        color: "#ffffffcc",
                        fontSize: 11,
                        lineHeight: 1,
                        fontVariantNumeric: "tabular-nums",
                        textAlign: "right",
                      }}
                    >
                      {m.toLocaleString(undefined, { maximumFractionDigits: 0 })} m
                    </span>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div style={{
                width: 14,
                height: 160,
                borderRadius: 7,
                flexShrink: 0,
                background: `linear-gradient(to top, ${COLORS.join(", ")})`,
              }} />
              <div style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                height: 160,
              }}>
                {legendStops.slice().reverse().map((v, i) => (
                  <span key={i} style={{ color: "#ffffffcc", fontSize: 11, lineHeight: 1 }}>
                    {v.toFixed(1)}%
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {hoverElevation !== null && (
        <div style={{
          position: "fixed",
          left: 16,
          bottom: 24,
          background: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(12px)",
          borderRadius: 10,
          padding: "10px 14px",
          zIndex: 10,
          minWidth: 140,
        }}>
          <div style={{ color: "#ffffff99", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
            Elevation
          </div>
          {hoverElevation.ok ? (
            <>
              <div style={{ color: "#fff", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                {(hoverElevation.meters * M_TO_FT).toLocaleString(undefined, { maximumFractionDigits: 0 })} ft
              </div>
              <div style={{ color: "#ffffffcc", fontSize: 12, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                {hoverElevation.meters.toLocaleString(undefined, { maximumFractionDigits: 1 })} m
              </div>
            </>
          ) : hoverElevation.pending ? (
            <div style={{ color: "#ffffffaa", fontSize: 13 }}>
              …
            </div>
          ) : (
            <div style={{ color: "#ffffffaa", fontSize: 13 }}>
              —
            </div>
          )}
        </div>
      )}

      {viewMode === "roads" && pct !== null && (
        <div style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(12px)",
          padding: "10px 20px 8px",
          borderRadius: 10,
          zIndex: 10,
          minWidth: 260,
        }}>
          <div style={{ color: "#ffffffcc", fontSize: 12, marginBottom: 6 }}>
            Computing grades — {progress!.processed} / {progress!.total} roads
          </div>
          <Progress
            percent={pct}
            strokeColor="#1677ff"
            trailColor="rgba(255,255,255,0.12)"
            showInfo={false}
            size="small"
          />
        </div>
      )}

      {(viewMode === "terrain" || viewMode === "heightmap") && remaining !== null && remaining > 0 && (
        <div style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(12px)",
          padding: "10px 20px 8px",
          borderRadius: 10,
          zIndex: 10,
          minWidth: 220,
        }}>
          <div style={{ color: "#ffffffcc", fontSize: 12 }}>
            {remaining.toLocaleString()} cells remaining
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
