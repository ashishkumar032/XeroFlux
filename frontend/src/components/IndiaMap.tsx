import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as LibreMap, type StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { components } from '../api/schema';
import { useTheme } from '../theme';
import 'maplibre-gl/dist/maplibre-gl.css';

type GeometryCollection = components['schemas']['GeometryCollection'];
type RainfallRecord = components['schemas']['RainfallRecord'];
type EventRecord = components['schemas']['EventRecord'];
type TrackRecord = components['schemas']['TrackRecord'];

export type Basemap = 'dark' | 'terrain' | 'satellite';

export interface IndiaMapProps {
  boundaries?: GeometryCollection;
  selectedState?: string;
  onSelect?: (id: string) => void;
  showStateSelector?: boolean;
  /** Suggests Terrain when landslides or basin context is active; user selection still wins. */
  basemapHint?: 'terrain';
  rainfall?: RainfallRecord[];
  points?: EventRecord[];
  track?: TrackRecord[];
  activePoint?: TrackRecord;
  unit?: string | null;
}

const BASEMAPS: Record<Basemap, { label: string; tiles: string; maxzoom: number; attribution: string }> = {
  dark: {
    label: 'Dark analytics',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 16,
    attribution: 'Basemap © Esri, HERE, Garmin, OpenStreetMap contributors',
  },
  terrain: {
    label: 'Terrain',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 18,
    attribution: 'Basemap © Esri, USGS, NOAA and contributors',
  },
  satellite: {
    label: 'Satellite',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};
const BASEMAP_IDS = Object.keys(BASEMAPS) as Basemap[];
/** ColorBrewer YlGnBu: perceptually ordered light gold to deep cobalt. */
const YLGNBU = ['#edf8b1', '#7fcdbb', '#1d91c0', '#081d58'] as const;

function paintFor(basemap: Basemap, theme: 'light' | 'dark') {
  const onDark = basemap !== 'terrain';
  return {
    canvas: basemap === 'terrain' ? (theme === 'dark' ? '#17232d' : '#eef4ec') : '#0b1420',
    noData: theme === 'dark' ? '#1e293b' : onDark ? '#334155' : '#e2e8f0',
    border: onDark ? '#cbd5e1' : '#475569',
    selected: onDark ? '#6ee7b7' : '#047857',
    halo: '#10b981',
    event: onDark ? '#2dd4bf' : '#0f766e',
    cyclone: onDark ? '#c4b5fd' : '#6d28d9',
    active: onDark ? '#fde68a' : '#b45309',
    activeStroke: onDark ? '#f8fafc' : '#0f172a',
    pointStroke: onDark ? '#0f172a' : '#ffffff',
    opacity: basemap === 'dark' ? 0.86 : basemap === 'terrain' ? 0.72 : 0.62,
  };
}

function fillExpression(range: { min: number; max: number } | null, noData: string): ExpressionSpecification {
  const value: ExpressionSpecification = ['number', ['feature-state', 'rainfall'], range?.min ?? 0];
  if (!range || !(range.max > range.min)) {
    return ['case', ['!=', ['feature-state', 'rainfall'], null], YLGNBU[2], noData];
  }
  const span = range.max - range.min;
  return [
    'case',
    ['!=', ['feature-state', 'rainfall'], null],
    ['interpolate', ['linear'], value,
      range.min, YLGNBU[0],
      range.min + span / 3, YLGNBU[1],
      range.min + (span * 2) / 3, YLGNBU[2],
      range.max, YLGNBU[3],
    ],
    noData,
  ];
}

const initialStyle = (color: string): StyleSpecification => ({
  version: 8,
  sources: {
    'basemap-dark': { type: 'raster', tiles: [BASEMAPS.dark.tiles], tileSize: 256, maxzoom: BASEMAPS.dark.maxzoom },
    'basemap-terrain': { type: 'raster', tiles: [BASEMAPS.terrain.tiles], tileSize: 256, maxzoom: BASEMAPS.terrain.maxzoom },
    'basemap-satellite': { type: 'raster', tiles: [BASEMAPS.satellite.tiles], tileSize: 256, maxzoom: BASEMAPS.satellite.maxzoom },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': color } },
    { id: 'basemap-dark', type: 'raster', source: 'basemap-dark', layout: { visibility: 'visible' } },
    { id: 'basemap-terrain', type: 'raster', source: 'basemap-terrain', layout: { visibility: 'none' } },
    { id: 'basemap-satellite', type: 'raster', source: 'basemap-satellite', layout: { visibility: 'none' } },
  ],
});
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const validPosition = (longitude: unknown, latitude: unknown): boolean =>
  typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180 &&
  typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90;

function boundaryExtent(boundaries: GeometryCollection): maplibregl.LngLatBounds | null {
  const bounds = new maplibregl.LngLatBounds();
  let found = false;
  for (const feature of boundaries.features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) for (const position of ring) {
      if (validPosition(position[0], position[1])) {
        bounds.extend([position[0], position[1]]);
        found = true;
      }
    }
  }
  return found ? bounds : null;
}

function rainfallByState(rows: RainfallRecord[] | undefined) {
  const records = new Map<string, RainfallRecord>();
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const row of rows ?? []) {
    if (seen.has(row.state_id)) {
      records.delete(row.state_id);
      ambiguous.add(row.state_id);
    } else {
      seen.add(row.state_id);
      if (Number.isFinite(row.value)) records.set(row.state_id, row);
    }
  }
  return { records, ambiguousStates: ambiguous.size };
}

function eventFeatures(rows: EventRecord[] | undefined): FeatureCollection<Point> {
  const features: FeatureCollection<Point>['features'] = [];
  for (const row of rows ?? []) {
    if (!validPosition(row.longitude, row.latitude)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.longitude!, row.latitude!] },
      properties: { event_id: row.event_id, state_id: row.state_id ?? '', timestamp: row.timestamp ?? '', year: row.year ?? null },
    });
  }
  return { type: 'FeatureCollection', features };
}

function trackFeatures(rows: TrackRecord[] | undefined): { route: FeatureCollection<LineString>; observations: FeatureCollection<Point> } {
  const route: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
  const observations: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
  let coordinates: number[][] = [];
  let storm = '';
  const finish = () => {
    if (coordinates.length >= 2) route.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { storm_id: storm } });
    coordinates = [];
  };
  for (const row of rows ?? []) {
    if (!validPosition(row.longitude, row.latitude)) { finish(); continue; }
    if (storm !== row.storm_id) finish();
    storm = row.storm_id;
    coordinates.push([row.longitude, row.latitude]);
    observations.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] }, properties: { ...row } });
  }
  finish();
  return { route, observations };
}

export interface MapDetailCardState {
  title: string;
  code?: string;
  value?: string;
  unit?: string;
  date?: string;
  lines: string[];
  x: number;
  y: number;
}

export interface StateLabelData {
  id: string;
  name: string;
  short: string;
  lng: number;
  lat: number;
  area: number;
  isCompact?: boolean;
}

export const STATE_LABEL_DEFS: StateLabelData[] = [
  { id: '01', name: 'Jammu & Kashmir', short: 'J&K', lng: 74.8593, lat: 33.6468, area: 5.18 },
  { id: '02', name: 'Himachal Pradesh', short: 'HP', lng: 77.2476, lat: 31.9236, area: 5.32 },
  { id: '03', name: 'Punjab', short: 'PB', lng: 75.4155, lat: 30.8424, area: 4.75 },
  { id: '04', name: 'Chandigarh', short: 'CH', lng: 76.7805, lat: 30.7294, area: 0.01, isCompact: true },
  { id: '05', name: 'Uttarakhand', short: 'UK', lng: 79.2073, lat: 30.1564, area: 5.00 },
  { id: '06', name: 'Haryana', short: 'HR', lng: 76.3402, lat: 29.1981, area: 4.10 },
  { id: '07', name: 'Delhi', short: 'DL', lng: 77.1155, lat: 28.6434, area: 0.14, isCompact: true },
  { id: '08', name: 'Rajasthan', short: 'RJ', lng: 73.8499, lat: 26.5846, area: 31.01 },
  { id: '09', name: 'Uttar Pradesh', short: 'UP', lng: 80.5662, lat: 26.9236, area: 21.90 },
  { id: '10', name: 'Bihar', short: 'BR', lng: 85.6108, lat: 25.6791, area: 8.47 },
  { id: '11', name: 'Sikkim', short: 'SK', lng: 88.4732, lat: 27.5698, area: 0.65, isCompact: true },
  { id: '12', name: 'Arunachal Pradesh', short: 'AR', lng: 94.6740, lat: 28.0353, area: 7.53, isCompact: true },
  { id: '13', name: 'Nagaland', short: 'NL', lng: 94.4663, lat: 26.0622, area: 1.50, isCompact: true },
  { id: '14', name: 'Manipur', short: 'MN', lng: 93.8788, lat: 24.7339, area: 1.99, isCompact: true },
  { id: '15', name: 'Mizoram', short: 'MZ', lng: 92.8318, lat: 23.3070, area: 1.86, isCompact: true },
  { id: '16', name: 'Tripura', short: 'TR', lng: 91.7407, lat: 23.7456, area: 0.93, isCompact: true },
  { id: '17', name: 'Meghalaya', short: 'ML', lng: 91.2784, lat: 25.5354, area: 2.01, isCompact: true },
  { id: '18', name: 'Assam', short: 'AS', lng: 92.8260, lat: 26.3553, area: 7.10 },
  { id: '19', name: 'West Bengal', short: 'WB', lng: 87.9753, lat: 23.8448, area: 7.44 },
  { id: '20', name: 'Jharkhand', short: 'JH', lng: 85.5615, lat: 23.6546, area: 7.06 },
  { id: '21', name: 'Odisha', short: 'OD', lng: 84.4291, lat: 20.5129, area: 13.47 },
  { id: '22', name: 'Chhattisgarh', short: 'CG', lng: 82.0411, lat: 21.2663, area: 11.77 },
  { id: '23', name: 'Madhya Pradesh', short: 'MP', lng: 78.2893, lat: 23.5384, area: 27.27 },
  { id: '24', name: 'Gujarat', short: 'GJ', lng: 71.5695, lat: 22.6947, area: 16.47 },
  { id: '27', name: 'Maharashtra', short: 'MH', lng: 76.1071, lat: 19.4511, area: 26.47 },
  { id: '28', name: 'Andhra Pradesh', short: 'AP', lng: 79.9666, lat: 15.7566, area: 13.77 },
  { id: '29', name: 'Karnataka', short: 'KA', lng: 76.1671, lat: 14.7099, area: 16.10 },
  { id: '30', name: 'Goa', short: 'GA', lng: 74.0501, lat: 15.3645, area: 0.31, isCompact: true },
  { id: '31', name: 'Lakshadweep', short: 'LD', lng: 74.0430, lat: 11.2769, area: 0.05, isCompact: true },
  { id: '32', name: 'Kerala', short: 'KL', lng: 76.4074, lat: 10.4511, area: 3.21 },
  { id: '33', name: 'Tamil Nadu', short: 'TN', lng: 78.4096, lat: 11.0154, area: 10.78 },
  { id: '34', name: 'Puducherry', short: 'PY', lng: 79.8036, lat: 10.9323, area: 0.04, isCompact: true },
  { id: '35', name: 'Andaman & Nicobar Island', short: 'AN', lng: 92.8298, lat: 12.6022, area: 0.62, isCompact: true },
  { id: '36', name: 'Telangana', short: 'TS', lng: 79.0079, lat: 17.8008, area: 9.55 },
  { id: '37', name: 'Ladakh', short: 'LK', lng: 76.7793, lat: 34.9462, area: 16.75 },
  { id: '38', name: 'Dadra & Nagar Havelli and Daman & Diu', short: 'DNH & DD', lng: 73.0191, lat: 20.2510, area: 0.05, isCompact: true },
];

/** Official backend polygons over an optional free raster basemap. If tiles fail offline, official polygons still render. */
export default function IndiaMap(props: IndiaMapProps) {
  const { boundaries, selectedState, onSelect, showStateSelector = true, basemapHint, rainfall, points, track, activePoint, unit } = props;
  const { theme } = useTheme();
  const [userBasemap, setUserBasemap] = useState<Basemap | null>(null);
  const basemap: Basemap = userBasemap ?? 'terrain';
  const [paintedTheme, setPaintedTheme] = useState<typeof theme | null>(null);
  const [basemapOffline, setBasemapOffline] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const labelsSvgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const [detailCard, setDetailCard] = useState<MapDetailCardState | null>(null);
  const [hoveredStateId, setHoveredStateId] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const live = useRef(props);
  const styleState = useRef({ theme, basemap });
  const syncRef = useRef<() => void>(() => {});
  const extentRef = useRef<maplibregl.LngLatBounds | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const rainfallSelection = useMemo(() => rainfallByState(rainfall), [rainfall]);
  const rain = rainfallSelection.records;
  const values = useMemo(() => Array.from(rain.values(), row => row.value), [rain]);
  const range = useMemo(() => {
    if (!values.length) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
    return { min, max };
  }, [values]);
  const states = useMemo(() => boundaries?.features.map(feature => feature.properties).sort((a, b) => a.name.localeCompare(b.name)) ?? [], [boundaries]);
  const stateLabels = useMemo(() => {
    return STATE_LABEL_DEFS.map(def => {
      const match = boundaries?.features.find(f => f.properties.state_id === def.id);
      return {
        ...def,
        name: match?.properties.name ?? def.name,
      };
    });
  }, [boundaries]);
  const eventData = useMemo(() => eventFeatures(points), [points]);
  const trackData = useMemo(() => trackFeatures(track), [track]);
  const activeData = useMemo<FeatureCollection<Point>>(() => ({
    type: 'FeatureCollection',
    features: activePoint && validPosition(activePoint.longitude, activePoint.latitude)
      ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [activePoint.longitude, activePoint.latitude] }, properties: { ...activePoint } }]
      : [],
  }), [activePoint]);
  const view = useRef({ rain, range, eventData, trackData, activeData });

  useEffect(() => {
    live.current = props;
    view.current = { rain, range, eventData, trackData, activeData };
    styleState.current = { theme, basemap };
    syncRef.current();
  }, [props, rain, range, eventData, trackData, activeData, theme, basemap]);

  useEffect(() => {
    if (!container.current) return;
    let map: LibreMap;
    let popup: maplibregl.Popup | null = null;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let loaded = false;
    let currentBoundaries: GeometryCollection | undefined;
    let currentEvents: typeof eventData | undefined;
    let currentTrack: typeof trackData | undefined;
    let currentActive: typeof activeData | undefined;
    let currentRain: typeof rain | undefined;
    let currentStyleKey = '';
    let fitted = false;
    let failed = false;
    const fail = (message: string) => {
      if (disposed) return;
      failed = true;
      setReady(false);
      setMapError(message);
    };
    try {
      const initial = paintFor(styleState.current.basemap, styleState.current.theme);
      map = new maplibregl.Map({
        container: container.current,
        style: initialStyle(initial.canvas),
        center: [80, 23],
        zoom: 3,
        attributionControl: false,
        renderWorldCopies: false,
        keyboard: true,
        maxZoom: 14,
      });
      mapRef.current = map;
    } catch {
      fail('The geographic map could not start. WebGL may be unavailable. Use the state selector and data panels instead.');
      return;
    }
    const contextLost = () => fail('The map lost its graphics context. Use the state selector and data panels; reload the page to restore the map.');
    map.getCanvas().addEventListener('webglcontextlost', contextLost);
    map.on('error', (event: { sourceId?: string; error?: { message?: string } }) => {
      if (typeof event.sourceId === 'string' && event.sourceId.startsWith('basemap-')) {
        if (!disposed) setBasemapOffline(true);
        return;
      }
      fail(`The geographic map encountered a rendering or source error: ${event.error?.message ?? 'Unknown map error'}. Map completeness cannot be confirmed. Use the state selector and data panels instead.`);
    });
    const updateReady = () => {
      if (!disposed && !failed && currentBoundaries && map.getLayer('state-fill') && map.getLayer('selected-state') && map.isSourceLoaded('official-states')) setReady(true);
    };
    map.on('sourcedata', updateReady);
    const updateLabels = () => {
      if (!mapRef.current || !labelsSvgRef.current || !container.current) return;
      const m = mapRef.current;
      const zoom = m.getZoom();
      const w = container.current.clientWidth;
      const h = container.current.clientHeight;
      const isMobile = w < 560;

      for (const state of stateLabels) {
        const el = labelsSvgRef.current.querySelector(`#map-label-${state.id}`) as SVGTextElement | null;
        if (!el) continue;

        const pt = m.project([state.lng, state.lat]);
        if (pt.x < -60 || pt.x > w + 60 || pt.y < -40 || pt.y > h + 40) {
          el.style.display = 'none';
          continue;
        }

        el.style.display = '';
        el.setAttribute('x', pt.x.toFixed(1));
        el.setAttribute('y', pt.y.toFixed(1));

        const isHovered = hoveredRef.current === state.id;
        const isSelected = live.current.selectedState === state.id;

        let text = state.name;
        if (isHovered || isSelected) {
          text = state.name;
        } else if (state.isCompact && zoom < 5.6) {
          text = state.short;
        } else if (isMobile && zoom < 4.8 && state.area < 10) {
          text = state.short;
        } else if (zoom < 4.3 && state.area < 6.0) {
          text = state.short;
        }
        if (el.textContent !== text) {
          el.textContent = text;
        }

        el.classList.toggle('is-hovered', isHovered);
        el.classList.toggle('is-selected', isSelected);
      }
    };

    map.on('render', updateLabels);
    map.on('move', updateLabels);
    map.on('zoom', updateLabels);
    map.on('resize', updateLabels);
    map.on('sourcedata', updateReady);
    map.on('idle', updateReady);
    const sync = () => {
      if (!loaded || disposed || failed) return;
      const next = live.current;
      const data = view.current;
      const { theme: nextTheme, basemap: nextBasemap } = styleState.current;
      const nextStyleKey = `${nextBasemap}:${nextTheme}`;
      const styleChanged = currentStyleKey !== nextStyleKey;
      const paint = paintFor(nextBasemap, nextTheme);
      try {
        if (next.boundaries !== currentBoundaries) {
          setReady(false);
          currentBoundaries = next.boundaries;
          (map.getSource('official-states') as GeoJSONSource).setData(next.boundaries ?? EMPTY);
          currentRain = undefined;
          extentRef.current = next.boundaries ? boundaryExtent(next.boundaries) : null;
          if (!fitted && extentRef.current) {
            map.fitBounds(extentRef.current, { padding: 30, duration: 0 });
            fitted = true;
          }
        }
        if (currentRain !== data.rain) {
          map.removeFeatureState({ source: 'official-states' });
          for (const [stateId, row] of data.rain) map.setFeatureState({ source: 'official-states', id: stateId }, { rainfall: row.value });
        }
        if (currentRain !== data.rain || styleChanged) {
          map.setPaintProperty('state-fill', 'fill-color', fillExpression(data.range, paint.noData));
          currentRain = data.rain;
        }
        if (styleChanged) {
          for (const id of BASEMAP_IDS) {
            map.setLayoutProperty(`basemap-${id}`, 'visibility', id === nextBasemap ? 'visible' : 'none');
          }
          map.setPaintProperty('background', 'background-color', paint.canvas);
          map.setPaintProperty('state-fill', 'fill-opacity', paint.opacity);
          map.setPaintProperty('state-border', 'line-color', paint.border);
          map.setPaintProperty('selected-state-halo', 'line-color', paint.halo);
          map.setPaintProperty('selected-state', 'line-color', paint.selected);
          map.setPaintProperty('event-clusters', 'circle-color', paint.event);
          map.setPaintProperty('event-clusters', 'circle-stroke-color', paint.pointStroke);
          map.setPaintProperty('event-points', 'circle-color', paint.event);
          map.setPaintProperty('event-points', 'circle-stroke-color', paint.pointStroke);
          map.setPaintProperty('cyclone-line', 'line-color', paint.cyclone);
          map.setPaintProperty('cyclone-points', 'circle-color', paint.cyclone);
          map.setPaintProperty('active-point', 'circle-color', paint.active);
          map.setPaintProperty('active-point', 'circle-stroke-color', paint.activeStroke);
          currentStyleKey = nextStyleKey;
          setPaintedTheme(nextTheme);
        }
        const selectedFilter: ExpressionSpecification = ['==', ['get', 'state_id'], next.selectedState ?? ''];
        map.setFilter('selected-state-halo', selectedFilter);
        map.setFilter('selected-state', selectedFilter);
        if (currentEvents !== data.eventData) { (map.getSource('observed-events') as GeoJSONSource).setData(data.eventData); currentEvents = data.eventData; }
        if (currentTrack !== data.trackData) {
          if (next.track?.length && extentRef.current) {
            const base = next.boundaries ? boundaryExtent(next.boundaries) : extentRef.current;
            const extent = new maplibregl.LngLatBounds(base!.getSouthWest(), base!.getNorthEast());
            for (const point of next.track) {
              if (!validPosition(point.longitude, point.latitude)) continue;
              extent.extend([point.longitude, point.latitude]);
            }
            extentRef.current = extent;
            map.fitBounds(extent, { padding: 30, duration: 0 });
          }
          (map.getSource('cyclone-route') as GeoJSONSource).setData(data.trackData.route);
          (map.getSource('cyclone-observations') as GeoJSONSource).setData(data.trackData.observations);
          currentTrack = data.trackData;
        }
        if (currentActive !== data.activeData) { (map.getSource('active-observation') as GeoJSONSource).setData(data.activeData); currentActive = data.activeData; }
      } catch { fail('Official map layers could not be updated. Use the state selector and data panels instead.'); }
    };
    syncRef.current = sync;
    map.on('load', () => {
      if (disposed) return;
      try {
        const paint = paintFor(styleState.current.basemap, styleState.current.theme);
        map.addSource('official-states', { type: 'geojson', data: EMPTY, promoteId: 'state_id' });
        map.addLayer({ id: 'state-fill', type: 'fill', source: 'official-states', paint: { 'fill-color': paint.noData, 'fill-opacity': paint.opacity } });
        map.addLayer({ id: 'state-border', type: 'line', source: 'official-states', paint: { 'line-color': paint.border, 'line-width': 0.8 } });
        map.addLayer({
          id: 'selected-state-halo',
          type: 'line',
          source: 'official-states',
          filter: ['==', ['get', 'state_id'], ''],
          paint: { 'line-color': paint.halo, 'line-width': 8, 'line-opacity': 0.4, 'line-blur': 2 },
        });
        map.addLayer({ id: 'selected-state', type: 'line', source: 'official-states', filter: ['==', ['get', 'state_id'], ''], paint: { 'line-color': paint.selected, 'line-width': 2.2 } });
        map.addSource('observed-events', { type: 'geojson', data: EMPTY, cluster: true, clusterRadius: 42, clusterMaxZoom: 10 });
        map.addLayer({ id: 'event-clusters', type: 'circle', source: 'observed-events', filter: ['has', 'point_count'], paint: { 'circle-color': paint.event, 'circle-radius': ['step', ['get', 'point_count'], 14, 20, 20, 100, 26], 'circle-stroke-color': paint.pointStroke, 'circle-stroke-width': 1.2 } });
        map.addLayer({ id: 'event-points', type: 'circle', source: 'observed-events', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': paint.event, 'circle-radius': 5, 'circle-stroke-color': paint.pointStroke, 'circle-stroke-width': 1.2 } });
        map.addSource('cyclone-route', { type: 'geojson', data: EMPTY });
        map.addLayer({ id: 'cyclone-line', type: 'line', source: 'cyclone-route', paint: { 'line-color': paint.cyclone, 'line-width': 3 } });
        map.addSource('cyclone-observations', { type: 'geojson', data: EMPTY });
        map.addLayer({ id: 'cyclone-points', type: 'circle', source: 'cyclone-observations', paint: { 'circle-color': paint.cyclone, 'circle-radius': 3 } });
        map.addSource('active-observation', { type: 'geojson', data: EMPTY });
        map.addLayer({ id: 'active-point', type: 'circle', source: 'active-observation', paint: { 'circle-color': paint.active, 'circle-radius': 8, 'circle-stroke-color': paint.activeStroke, 'circle-stroke-width': 3 } });
        loaded = true;
        sync();
      } catch { fail('The official boundary and observation layers could not be initialized. Use the state selector and data panels instead.'); }
    });
    map.on('click', 'state-fill', event => {
      const stateId: unknown = event.features?.[0]?.properties?.state_id;
      if (map.queryRenderedFeatures(event.point, { layers: ['event-clusters', 'event-points', 'cyclone-points', 'active-point'] }).length) return;
      if (typeof stateId === 'string') live.current.onSelect?.(stateId);
    });
    map.on('click', 'event-clusters', event => {
      const feature = event.features?.[0];
      const clusterId: unknown = feature?.properties?.cluster_id;
      if (typeof clusterId !== 'number' || feature?.geometry.type !== 'Point') return;
      const center = feature.geometry.coordinates as [number, number];
      void (map.getSource('observed-events') as GeoJSONSource).getClusterExpansionZoom(clusterId).then(zoom => {
        if (!disposed && !failed) map.easeTo({ center, zoom, duration: 0 });
      }).catch(() => fail('The event cluster could not be expanded. Use the event list instead.'));
    });
    map.on('mousemove', event => {
      if (!loaded || failed) return;
      const features = map.queryRenderedFeatures(event.point, {
        layers: ['active-point', 'event-clusters', 'event-points', 'cyclone-points', 'state-fill']
      });
      const feature = features[0];

      if (!feature) {
        map.getCanvas().style.cursor = '';
        if (hoveredRef.current !== null) {
          hoveredRef.current = null;
          setHoveredStateId(null);
          updateLabels();
        }
        setDetailCard(null);
        return;
      }

      map.getCanvas().style.cursor = 'pointer';
      const fields = feature.properties;
      let title: string;
      let code: string | undefined;
      let figure: { value: string; unit: string } | undefined;
      let date: string | undefined;
      const lines: string[] = [];

      if (feature.layer.id === 'state-fill') {
        const stateId = String(fields.state_id);
        if (hoveredRef.current !== stateId) {
          hoveredRef.current = stateId;
          setHoveredStateId(stateId);
          updateLabels();
        }
        const stateMeta = STATE_LABEL_DEFS.find(s => s.id === stateId);
        const row = view.current.rain.get(stateId);
        const unitLabel = live.current.unit ?? 'unit not declared';

        title = String(fields.name || stateMeta?.name || 'State');
        code = stateMeta?.short ?? stateId;

        if (row) {
          figure = { value: row.value.toLocaleString(), unit: unitLabel };
          date = String(row.date ?? row.year);
        } else {
          lines.push(live.current.rainfall === undefined ? 'Reference boundary; rainfall not selected' : 'No rainfall observation for this date');
        }
      } else if (feature.layer.id === 'event-clusters') {
        if (hoveredRef.current !== null) {
          hoveredRef.current = null;
          setHoveredStateId(null);
          updateLabels();
        }
        title = `${String(fields.point_count)} observed events`;
        lines.push('Click to zoom into this cluster');
      } else if (feature.layer.id === 'event-points') {
        if (hoveredRef.current !== null) {
          hoveredRef.current = null;
          setHoveredStateId(null);
          updateLabels();
        }
        title = `Event ${String(fields.event_id)}`;
        if (fields.state_id) code = String(fields.state_id);
        date = String(fields.timestamp || fields.year || 'Not recorded');
      } else {
        if (hoveredRef.current !== null) {
          hoveredRef.current = null;
          setHoveredStateId(null);
          updateLabels();
        }
        title = `Storm ${String(fields.storm_id)}`;
        date = String(fields.timestamp);
        if (typeof fields.wind === 'number') {
          lines.push(`Wind: ${fields.wind} ${fields.wind_unit || 'kts'}`);
        }
        if (typeof fields.pressure === 'number') {
          lines.push(`Pressure: ${fields.pressure} ${fields.pressure_unit || 'mb'}`);
        }
      }

      // Compute intentional offset & viewport boundary clamping
      const w = container.current?.clientWidth ?? 800;
      const h = container.current?.clientHeight ?? 500;
      const cardW = Math.min(260, w - 24);
      const cardH = 92;
      const cursorX = event.point.x;
      const cursorY = event.point.y;
      const offsetDist = 18;

      let targetX = cursorX + offsetDist;
      let targetY = cursorY + offsetDist;

      // Flip left if extending past right edge
      if (cursorX + offsetDist + cardW > w - 12) {
        targetX = cursorX - cardW - offsetDist;
      }
      // Flip up if extending past bottom edge
      if (cursorY + offsetDist + cardH > h - 12) {
        targetY = cursorY - cardH - offsetDist;
      }

      // Strict boundary clamping within container
      targetX = Math.max(12, Math.min(w - cardW - 12, targetX));
      targetY = Math.max(12, Math.min(h - cardH - 12, targetY));

      setDetailCard({
        title,
        code,
        value: figure?.value,
        unit: figure?.unit,
        date,
        lines,
        x: targetX,
        y: targetY,
      });
    });
    const clearHover = () => {
      setDetailCard(null);
      if (hoveredRef.current !== null) {
        hoveredRef.current = null;
        setHoveredStateId(null);
        updateLabels();
      }
    };
    map.getCanvas().addEventListener('mouseleave', clearHover);
    if (typeof ResizeObserver !== 'undefined' && container.current) {
      observer = new ResizeObserver(() => { if (!disposed) map.resize(); });
      observer.observe(container.current);
    }
    return () => {
      disposed = true;
      syncRef.current = () => {};
      observer?.disconnect();
      map.getCanvas().removeEventListener('webglcontextlost', contextLost);
      map.getCanvas().removeEventListener('mouseleave', clearHover);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const currentPaint = paintFor(basemap, theme);
  const skippedEvents = (points?.length ?? 0) - eventData.features.length;
  const skippedTrack = (track?.length ?? 0) - trackData.observations.features.length;
  return <section aria-label="Official India observation map">
    <div className="filter-row" aria-label="Map controls">
      <button className="button" type="button" disabled={!ready || !!mapError} aria-label="Zoom map in" onClick={() => mapRef.current?.zoomIn({ duration: 0 })}>Zoom +</button>
      <button className="button" type="button" disabled={!ready || !!mapError} aria-label="Zoom map out" onClick={() => mapRef.current?.zoomOut({ duration: 0 })}>Zoom −</button>
      <button className="button" type="button" disabled={!ready || !!mapError} onClick={() => { if (extentRef.current) mapRef.current?.fitBounds(extentRef.current, { padding: 30, duration: 0 }); }}>Reset map extent</button>
      {basemapHint === 'terrain' && basemap !== 'terrain' && <button className="button" type="button" onClick={() => setUserBasemap('terrain')}>Terrain recommended for slope/basin context</button>}
      {onSelect && (showStateSelector || mapError) && <label>Map state selection <select value={selectedState ?? ''} disabled={!states.length} onChange={event => onSelect(event.target.value)}>
        <option value="">Select a state</option>{states.map(state => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
      </select></label>}
    </div>
    <div className="map-frame">
      <div ref={container} className="map-canvas" role="region" aria-label="Interactive official India state boundaries and observed records. Use arrow keys to pan and plus or minus to zoom; state selection is available above." style={{ width: '100%' }} />
      <svg ref={labelsSvgRef} className="map-labels-overlay" aria-hidden="true">
        {stateLabels.map(state => (
          <text
            key={state.id}
            id={`map-label-${state.id}`}
            className={`state-label ${state.isCompact ? 'is-compact' : ''} ${selectedState === state.id ? 'is-selected' : ''}`}
            x={0}
            y={0}
            style={{ display: 'none' }}
          >
            {state.name}
          </text>
        ))}
      </svg>
      {detailCard && (
        <div
          className="map-hud map-detail-card maplibregl-popup-content"
          style={{
            left: `${detailCard.x}px`,
            top: `${detailCard.y}px`,
          }}
          role="status"
          aria-live="polite"
        >
          <div className="map-popup-title">
            <span>{detailCard.title}</span>
            {detailCard.code && <span className="map-popup-badge">{detailCard.code}</span>}
          </div>
          {detailCard.value && (
            <div className="map-popup-value">
              {detailCard.value}
              {detailCard.unit && <small> {detailCard.unit}</small>}
            </div>
          )}
          {detailCard.date && (
            <div className="map-popup-line map-popup-date">
              Recorded date: <time dateTime={detailCard.date}>{detailCard.date}</time>
            </div>
          )}
          {detailCard.lines.map((line, i) => (
            <div key={i} className="map-popup-line">{line}</div>
          ))}
        </div>
      )}
      <div className="map-hud map-basemap-switcher" role="group" aria-label="Basemap style">
        {BASEMAP_IDS.map(id => <button key={id} type="button" className="basemap-option" aria-pressed={basemap === id}
          onClick={() => { setBasemapOffline(false); setUserBasemap(id); }}>
          {BASEMAPS[id].label}{id === 'terrain' && basemapHint === 'terrain' ? ' · slope' : ''}
        </button>)}
      </div>
      {rainfall !== undefined && range && <div className="map-hud map-gradient-legend" aria-label="Rainfall choropleth scale">
        <div className="legend-title">Rainfall ({unit ?? 'unit not declared'})</div>
        <div className="legend-ramp" aria-hidden="true" />
        <div className="legend-stops"><span>{range.min.toLocaleString()}</span><span>{range.max.toLocaleString()}</span></div>
      </div>}
    </div>
    <p role="status" data-map-ready={ready && !mapError ? 'true' : 'false'} data-map-theme={paintedTheme ?? undefined}>{mapError ?? (ready ? 'Map ready — official boundary source loaded and layers added.' : boundaries ? 'Loading official boundary map…' : 'Official boundary data is not available yet.')}</p>
    {mapError && <p className="muted">The map is unavailable; no replacement outline or simulated observations are shown. Use the state selectors, charts and recorded-event lists.</p>}
    {basemapOffline && <p className="muted">External basemap tiles did not load (offline or blocked); official state boundaries and observations remain accurate.</p>}
    <div className="map-legend" aria-label="Map legend">
      <span><span aria-hidden="true" style={{ color: currentPaint.noData }}>■</span> {rainfall === undefined ? 'Reference boundaries' : 'No rainfall observation'}</span>
      {rainfall !== undefined && (range ? <span><span aria-hidden="true" style={{ color: YLGNBU[2] }}>■</span> YlGnBu scale {range.min.toLocaleString()}–{range.max.toLocaleString()} {unit ?? '(unit not declared)'}. Measured zero remains an observation.</span> : <span>No numeric rainfall range available.</span>)}
      {!!points?.length && <span> · <span aria-hidden="true" style={{ color: currentPaint.event }}>●</span> Observed events; larger circles are clusters (hover for count).</span>}
      {!!track?.length && <span> · <span aria-hidden="true" style={{ color: currentPaint.cyclone }}>━</span> Recorded cyclone route · <span aria-hidden="true" style={{ color: currentPaint.active }}>●</span> Active recorded observation.</span>}
    </div>
    {rainfallSelection.ambiguousStates > 0 && <p className="muted">Rainfall omitted for {rainfallSelection.ambiguousStates} states because multiple observations were returned for the same state. Choose a single observation date in the filters.</p>}
    {(skippedEvents > 0 || skippedTrack > 0) && <p className="muted">Not mapped because valid geographic coordinates were unavailable: {skippedEvents} event records; {skippedTrack} track records. No locations were inferred.</p>}
    <p className="map-attribution">Boundaries: NWIC / Survey of India. {BASEMAPS[basemap].attribution}.</p>
  </section>;
}
