import './App.css'
import Map from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxToken } from "./config.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeGradients, GradientStore } from "./computeGradients.ts";
import { Progress } from "antd";
import { useSpring } from "pat-web-utils";

const mapStyle = "mapbox://styles/paricdil/cme3ipbul01pr01s24ymeep2j";

const GRADIENT_SOURCE = "gradient-data";
const GRADIENT_LAYER = "gradient-lines";
const ROAD_QUERY_SOURCE = "streets-v8";

const MIN_SCALE = 6;
const MAX_SCALE = 25;
const PERCENTILE = 0.975;
const COLORS = ["#00ff00", "#ffff00", "#ff0000", "#ff00ff", "#ffffff"];

function buildColorExpression(maxGrade: number) {
  const step = maxGrade / (COLORS.length - 1);
  return [
    "interpolate",
    ["linear"],
    ["get", "grade"],
    ...COLORS.flatMap((color, i) => [step * i, color]),
  ];
}

const ROAD_LOADER_LAYER = "road-loader";

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

function ensureGradientLayer(map: mapboxgl.Map, maxGrade: number) {
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
          'interpolate', ['linear'], ['zoom'],
          10, 1, 12, 2, 15, 5, 16, 5, 20, 10,
        ],
        "line-color": buildColorExpression(maxGrade) as any,
        'line-emissive-strength': 0.8,
        'line-opacity': 0.8,
      },
    });
  }
}

function App() {
  const [maxGradeTarget, setMaxGradeTarget] = useState(MIN_SCALE);
  const maxGrade = useSpring(maxGradeTarget);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const mapRef = useRef<MapRef>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const computingRef = useRef(false);
  const readyRef = useRef(false);
  const storeRef = useRef(new GradientStore());

  const colorExpr = useMemo(() => buildColorExpression(maxGrade), [maxGrade]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (map && map.getLayer(GRADIENT_LAYER)) {
      map.setPaintProperty(GRADIENT_LAYER, "line-color", colorExpr as any);
    }
  }, [colorExpr]);

  const onMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    ensureRoadSource(map);
    readyRef.current = true;
  }, []);

  const updateGradients = useCallback(() => {
    if (!readyRef.current || computingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const map = mapRef.current?.getMap();
      if (!map || !map.isStyleLoaded()) return;
      if (map.getZoom() < 11) return;

      ensureRoadSource(map);
      ensureGradientLayer(map, maxGradeTarget);

      computingRef.current = true;
      const src = map.getSource(GRADIENT_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      const store = storeRef.current;

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
        const pPercentile = grades[Math.floor(grades.length * PERCENTILE)];
        setMaxGradeTarget(Math.min(MAX_SCALE, Math.max(MIN_SCALE, pPercentile)));
      } finally {
        computingRef.current = false;
      }
    }, 300);
  }, [maxGradeTarget]);

  const pct = progress
    ? Math.round((progress.processed / progress.total) * 100)
    : null;

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
        onLoad={onMapLoad}
        onIdle={updateGradients}
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
            const grade = (maxGrade / (arr.length - 1)) * (arr.length - 1 - i);
            return (
              <span key={i} style={{ color: "#ffffffcc", fontSize: 11, lineHeight: 1 }}>
                {grade.toFixed(0)}%
              </span>
            );
          })}
        </div>
      </div>

      {pct !== null && (
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
    </div>
  )
}

export default App
