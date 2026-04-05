import './App.css'
import Map from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxToken } from "./config.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { processTick, SlopeStore } from "./computeSlopes.ts";
import { buildWaterIndex, isPointOverWater, waterVectorSourceId } from "./waterIndex.ts";
import { eleAtCoord } from "./elevation.ts";


const mapStyle = "mapbox://styles/mapbox/dark-v11";

const SLOPE_SOURCE = "slope-data";
const SLOPE_LAYER = "slope-fill";

/** Below this zoom, slope cells are not computed and the overlay is cleared (the map can still zoom out). */
const MIN_RENDER_ZOOM = 9;
const MAX_SCALE = 100;
/** Top of the scale uses this percentile of visible slopes (not 100%). */
const HIGH_PERCENTILE = 0.985;
/** One stop per color: P0, P20, P40, P60, P98.5 — scale position matches percentile except the cap above. */
const STOP_PERCENTILES = [0, 0.3, 0.6, 0.9, HIGH_PERCENTILE] as const;
const ZOOM_SETTLE_MS = 400;
const COLORS = ["#00ff00", "#ffff00", "#ff0000", "#ff00ff", "#ffffff"];

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

function buildFillColor(stops: readonly number[]) {
  const pairs = COLORS.flatMap((color, i) => [stops[i]!, color]);
  return ["interpolate", ["linear"], ["get", "slope"], ...pairs];
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

function ensureSlopeLayer(map: mapboxgl.Map, colorStops: readonly number[]) {
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
        "fill-color": buildFillColor(colorStops) as any,
        "fill-opacity": 0.9,
        "fill-antialias": false,
      },
    }, beforeId);
  }
}

function roundZoom(z: number): number {
  return Math.round(z * 100) / 100;
}

const INITIAL_STOPS: number[] = [0, 5, 10, 15, 20];

/** Meters above mean sea level → feet (international foot). */
const M_TO_FT = 3.280839895013123;

type HoverElevation =
  | { ok: true; meters: number }
  /** `pending`: fetching DEM via API (Mapbox often returns null from queryTerrainElevation until GPU tiles load). */
  | { ok: false; pending?: boolean };

function App() {
  const [colorStops, setColorStops] = useState<number[]>(INITIAL_STOPS);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [hoverElevation, setHoverElevation] = useState<HoverElevation | null>(null);
  const mapRef = useRef<MapRef>(null);
  const hoverElevSeqRef = useRef(0);
  const hoverElevDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeRef = useRef(new SlopeStore());
  const colorStopsRef = useRef(colorStops);
  colorStopsRef.current = colorStops;

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer(SLOPE_LAYER)) return;
    map.setPaintProperty(SLOPE_LAYER, "fill-color", buildFillColor(colorStops) as any);
  }, [colorStops]);

  useEffect(() => {
    let alive = true;
    let lastZoom: number | null = null;
    let zoomChangedAt = 0;

    async function loop() {
      while (alive) {
        const map = mapRef.current?.getMap();
        if (!map || !map.isStyleLoaded()) {
          await sleep(200);
          continue;
        }

        const zoom = roundZoom(map.getZoom());

        if (zoom < MIN_RENDER_ZOOM) {
          if (lastZoom === null || lastZoom >= MIN_RENDER_ZOOM) {
            storeRef.current = new SlopeStore();
            const src = map.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
            if (src) src.setData({ type: "FeatureCollection", features: [] });
            setRemaining(null);
          }
          lastZoom = zoom;
          await sleep(200);
          continue;
        }

        if (lastZoom !== null && zoom !== lastZoom) {
          storeRef.current = new SlopeStore();
          zoomChangedAt = Date.now();
          const src = map.getSource(SLOPE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData({ type: "FeatureCollection", features: [] });
        }
        lastZoom = zoom;

        if (Date.now() - zoomChangedAt < ZOOM_SETTLE_MS) {
          await sleep(50);
          continue;
        }

        ensureSlopeLayer(map, colorStopsRef.current);

        const bounds = map.getBounds()!;
        const canvas = map.getCanvas();
        const store = storeRef.current;

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
            updateScale(store, bounds, map);
          }
        } else {
          setRemaining(null);
          await sleep(150);
        }

        await sleep(0);
      }
    }

    function updateScale(store: SlopeStore, bounds: mapboxgl.LngLatBounds, _map: mapboxgl.Map) {
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
      const next = STOP_PERCENTILES.map((p) =>
        Math.min(MAX_SCALE, Math.max(0, percentileOfSorted(visibleSlopes, p))),
      );
      for (let i = 1; i < next.length; i++) {
        if (next[i]! < next[i - 1]!) next[i] = next[i - 1]!;
      }
      setColorStops(next);
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

  const totalVisible = remaining !== null ? remaining : null;

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{
          longitude: -122.4,
          latitude: 37.8,
          zoom: 14
        }}
        style={{ width: "100%", height: "100%" }}
        projection="globe"
        mapStyle={mapStyle}
        terrain={{ source: "mapbox-dem", exaggeration: 1 }}
        onLoad={() => {
          const map = mapRef.current?.getMap();
          if (!map) return;
          if (!map.getSource("mapbox-dem")) {
            map.addSource("mapbox-dem", {
              type: "raster-dem",
              url: "mapbox://mapbox.mapbox-terrain-dem-v1",
              tileSize: 512,
              maxzoom: 14,
            });
          }
          map.setTerrain({ source: "mapbox-dem", exaggeration: 1 });
        }}
        onMouseMove={onMapMouseMove}
        onMouseOut={onMapMouseOut}
      />
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
        alignItems: "center",
        gap: 10,
      }}>
        <div style={{
          width: 14,
          height: 160,
          borderRadius: 7,
          background: `linear-gradient(to top, ${COLORS.join(", ")})`,
        }} />
        <div style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: 160,
        }}>
          {colorStops.slice().reverse().map((slope, i) => (
            <span key={i} style={{ color: "#ffffffcc", fontSize: 11, lineHeight: 1 }}>
              {slope.toFixed(1)}%
            </span>
          ))}
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

      {totalVisible !== null && totalVisible > 0 && (
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
            {totalVisible.toLocaleString()} cells remaining
          </div>
        </div>
      )}
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default App
