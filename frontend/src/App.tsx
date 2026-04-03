import './App.css'
import Map, { Layer, Source } from "react-map-gl/mapbox";
import type { MapRef, SourceProps } from "react-map-gl";
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxToken } from "./config.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const mapStyle = "mapbox://styles/paricdil/cme3ipbul01pr01s24ymeep2j";

const gradientSource: SourceProps = {
  id: 'gradients',
  type: 'vector',
  tiles: [
    "http://localhost:8000/tiles/{z}/{x}/{y}.pbf",
  ],
  "minzoom": 11,
  "maxzoom": 13
};

const MIN_SCALE = 12;
const MAX_SCALE = 25;
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

function App() {
  const [size, setSize] = useState([600, 600]);
  const [maxGrade, setMaxGrade] = useState(MIN_SCALE);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapRef>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const recomputeMaxGrade = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const map = mapRef.current?.getMap();
      if (!map || !map.getLayer('gradients')) return;

      const features = map.queryRenderedFeatures({ layers: ['gradients'] });
      if (!features.length) return;

      const grades: number[] = [];
      for (const f of features) {
        const grade = f.properties?.grade;
        if (typeof grade === 'number' && grade > 0) grades.push(grade);
      }
      if (!grades.length) return;

      grades.sort((a, b) => a - b);
      const p95 = grades[Math.floor(grades.length * 0.99)];
      setMaxGrade(Math.min(MAX_SCALE, Math.max(MIN_SCALE, p95)));
    }, 100);
  }, []);

  const onResize = () => {
    setSize([containerRef.current?.offsetWidth || 600, containerRef.current?.offsetHeight || 600]);
  };

  useEffect(() => {
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [containerRef.current]);

  const gradientLayer = useMemo(() => ({
    id: 'gradients',
    type: 'line' as const,
    source: 'gradients',
    'source-layer': 'gradient',
    paint: {
      "line-width": [
        'interpolate',
        ['linear'],
        ['zoom'],
        10, 1,
        12, 2,
        15, 5,
        16, 5,
        20, 10,
      ],
      "line-color": buildColorExpression(maxGrade),
      'line-emissive-strength': 0.8,
      'line-opacity': 0.8,
    }
  }), [maxGrade]);

  return (
    <div ref={containerRef} style={{ width: "100vw", height: "100vh" }}>
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={{
          longitude: -122.4,
          latitude: 37.8,
          zoom: 14
        }}
        style={{
          width: size[0],
          height: size[1],
        }}
        projection="globe"
        mapStyle={mapStyle}
        onMoveEnd={recomputeMaxGrade}
        onData={recomputeMaxGrade}
      >
        <Source {...gradientSource}>
          <Layer {...gradientLayer} />
        </Source>
      </Map>
    </div>
  )
}

export default App
