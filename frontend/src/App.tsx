import './App.css'
import Map from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxToken } from "./config.ts";
import { useEffect, useRef, useState } from "react";
import { processTick, SlopeStore } from "./computeSlopes.ts";
import { buildWaterIndex, isPointOverWater, waterVectorSourceId } from "./waterIndex.ts";


const mapStyle = "mapbox://styles/mapbox/dark-v11";

const SLOPE_SOURCE = "slope-data";
const SLOPE_LAYER = "slope-fill";

/** Below this zoom, slope cells are not computed and the overlay is cleared (the map can still zoom out). */
const MIN_RENDER_ZOOM = 9;
const MIN_SCALE = 12;
const MAX_SCALE = 50;
const PERCENTILE = 0.985;
const ZOOM_SETTLE_MS = 400;
const COLORS = ["#00ff00", "#ffff00", "#ff0000", "#ff00ff", "#ffffff"];

function buildFillColor(maxSlope: number) {
  const step = maxSlope / (COLORS.length - 1);
  return [
    "interpolate",
    ["linear"],
    ["get", "slope"],
    ...COLORS.flatMap((color, i) => [step * i, color]),
  ];
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

function ensureSlopeLayer(map: mapboxgl.Map, maxSlope: number) {
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
        "fill-color": buildFillColor(maxSlope) as any,
        "fill-opacity": 0.9,
        "fill-antialias": false,
      },
    }, beforeId);
  }
}

function roundZoom(z: number): number {
  return Math.round(z * 100) / 100;
}

function App() {
  const [maxSlope, setMaxSlope] = useState(MIN_SCALE);
  const [remaining, setRemaining] = useState<number | null>(null);
  const mapRef = useRef<MapRef>(null);
  const storeRef = useRef(new SlopeStore());
  const maxSlopeRef = useRef(maxSlope);
  maxSlopeRef.current = maxSlope;

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer(SLOPE_LAYER)) return;
    map.setPaintProperty(SLOPE_LAYER, "fill-color", buildFillColor(maxSlope) as any);
  }, [maxSlope]);

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

        ensureSlopeLayer(map, maxSlopeRef.current);

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
      const pVal = visibleSlopes[Math.floor(visibleSlopes.length * PERCENTILE)];
      setMaxSlope(Math.min(MAX_SCALE, Math.max(MIN_SCALE, pVal)));
    }

    loop();
    return () => { alive = false; };
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
          {COLORS.slice().reverse().map((_, i, arr) => {
            const slope = (maxSlope / (arr.length - 1)) * (arr.length - 1 - i);
            return (
              <span key={i} style={{ color: "#ffffffcc", fontSize: 11, lineHeight: 1 }}>
                {slope.toFixed(0)}%
              </span>
            );
          })}
        </div>
      </div>

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
