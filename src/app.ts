// Общее ядро: состояние, карта, мелкие помощники интерфейса.
import maplibregl, { Map as MLMap, StyleSpecification } from 'maplibre-gl';
import { load, save, State } from './store';
import { DEM_URL } from './elevation';
import type { LatLon } from './geo';

export const S: State = load();
export const persist = () => save(S);

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
export const escapeHtml = (t: string) => t.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Подложки ----------
export const BASES: Record<string, { name: string; tiles: string[]; max: number; attr: string }> = {
  sat: { name: 'Спутник (Esri)', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], max: 19, attr: 'Снимки © Esri, Maxar, Earthstar Geographics' },
  topo: { name: 'Топо (OpenTopoMap)', tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], max: 17, attr: '© OpenStreetMap, SRTM · стиль © OpenTopoMap (CC-BY-SA)' },
  osm: { name: 'Схема (OSM)', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], max: 19, attr: '© участники OpenStreetMap' },
};

function style(): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    dem: { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Рельеф: Mapzen Terrain Tiles (AWS Open Data)' },
    roads: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
    places: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
  };
  const layers: StyleSpecification['layers'] = [{ id: 'bg', type: 'background', paint: { 'background-color': '#10151f' } }];
  for (const [id, b] of Object.entries(BASES)) {
    sources[id] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.max, attribution: b.attr };
    layers.push({ id: `base-${id}`, type: 'raster', source: id, layout: { visibility: id === S.map.base ? 'visible' : 'none' }, paint: { 'raster-brightness-max': 1 - S.map.dim } });
  }
  layers.push(
    { id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: S.map.hillshade ? 'visible' : 'none' }, paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#000', 'hillshade-highlight-color': '#fff8' } },
    { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: S.map.labels ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.85 } },
    { id: 'places', type: 'raster', source: 'places', layout: { visibility: S.map.labels ? 'visible' : 'none' } },
  );
  return { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources, layers };
}

export const map: MLMap = new maplibregl.Map({
  container: 'map',
  style: style(),
  center: S.map.center,
  zoom: S.map.zoom,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
  maxPitch: 0,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');

export function applyMapStyle() {
  for (const id of Object.keys(BASES)) {
    map.setLayoutProperty(`base-${id}`, 'visibility', id === S.map.base ? 'visible' : 'none');
    map.setPaintProperty(`base-${id}`, 'raster-brightness-max', 1 - S.map.dim);
  }
  map.setLayoutProperty('hillshade', 'visibility', S.map.hillshade ? 'visible' : 'none');
  for (const l of ['roads', 'places']) map.setLayoutProperty(l, 'visibility', S.map.labels ? 'visible' : 'none');
  document.body.classList.toggle('no-labels', !S.map.labels);
  $('btnLabels').classList.toggle('on', S.map.labels);
  persist();
}

export const center = (): LatLon => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; };

// ---------- GeoJSON-слои ----------
export function setGeo(id: string, data: GeoJSON.FeatureCollection | GeoJSON.Feature) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
}
export const fc = (features: GeoJSON.Feature[] = []): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
export const line = (pts: [number, number][], props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: props });

// ---------- Мелкие элементы интерфейса ----------
let toastT = 0;
export function toast(text: string, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove('show'), ms);
}

let sheetClose: (() => void) | null = null;
export function openSheet(title: string, body: HTMLElement | string, onClose?: () => void) {
  sheetClose?.();
  sheetClose = onClose || null;
  $('shTitle').textContent = title;
  const b = $('shBody');
  b.innerHTML = '';
  if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
  $('sheet').hidden = false;
  return b;
}
export function closeSheet() {
  $('sheet').hidden = true;
  sheetClose?.();
  sheetClose = null;
}
export const sheetOpen = () => !$('sheet').hidden;

export function progress(frac: number | null, text = '') {
  const p = $('progress');
  if (frac === null) { p.hidden = true; return; }
  p.hidden = false;
  (p.firstElementChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  p.querySelector('span')!.textContent = text;
}

export function field(label: string, input: string) {
  return `<label class="field"><span>${label}</span>${input}</label>`;
}

/** Простая шина событий между модулями. */
type Ev = 'station' | 'radio' | 'marks' | 'routes' | 'coords';
const subs = new Map<Ev, Set<() => void>>();
export const on = (e: Ev, f: () => void) => { if (!subs.has(e)) subs.set(e, new Set()); subs.get(e)!.add(f); };
export const emit = (e: Ev) => { persist(); subs.get(e)?.forEach((f) => f()); };
