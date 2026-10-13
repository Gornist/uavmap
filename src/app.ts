// Общее ядро: состояние, карта, мелкие помощники интерфейса.
import maplibregl, { Map as MLMap, StyleSpecification, RasterSourceSpecification } from 'maplibre-gl';
import { load, save, State } from './store';
import { DEM_URL } from './demTiles';
import type { LatLon } from './geo';
import { initTheme, resolvedTheme, MAP_THEME, THEMES } from './theme';

// Тема должна стоять до создания карты (цвет фона, яркость подложки). Повторный вызов из main.ts безопасен.
initTheme();

export const S: State = load();
// Ошибку записи показываем один раз за сессию — иначе toast повторялся бы при каждом сдвиге карты.
let saveWarned = false;
export const persist = () => save(S, () => {
  if (saveWarned) return;
  saveWarned = true;
  toast('Не хватает места в браузере, сделайте резервную копию', 6000);
});

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- Подложки ----------
export interface BaseDef { name: string; tiles: string[]; max: number; attr: string }
export const BASES: Record<string, BaseDef> = {
  sat: { name: 'Спутник (Esri)', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], max: 19, attr: 'Снимки © Esri, Maxar, Earthstar Geographics' },
  topo: { name: 'Топо (OpenTopoMap)', tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], max: 17, attr: '© OpenStreetMap, SRTM · стиль © OpenTopoMap (CC-BY-SA)' },
  osm: { name: 'Схема (OSM)', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], max: 19, attr: '© участники OpenStreetMap' },
};

/** Яркость подложки: пользовательское затемнение × приглушение ночной темы. */
const baseBrightness = () => (1 - S.map.dim) * MAP_THEME[resolvedTheme()].baseBrightness;

function style(): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    // maxzoom 13 — как у офлайн-районов и горизонталей; на крупных масштабах MapLibre растягивает z13.
    dem: { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, maxzoom: 13, encoding: 'terrarium', attribution: 'Рельеф: Mapzen Terrain Tiles (AWS Open Data)' },
    roads: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
    places: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
  };
  const layers: StyleSpecification['layers'] = [{ id: 'bg', type: 'background', paint: { 'background-color': MAP_THEME[resolvedTheme()].bg } }];
  for (const [id, b] of Object.entries(BASES)) {
    sources[id] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.max, attribution: b.attr };
    layers.push({ id: `base-${id}`, type: 'raster', source: id, layout: { visibility: id === S.map.base ? 'visible' : 'none' }, paint: { 'raster-brightness-max': baseBrightness() } });
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

/** Добавить подложку «на лету» (свои карты). Слой встаёт сразу над фоном — ниже отмывки, горизонталей и дорог. */
export function addBase(id: string, def: BaseDef, sourceSpec: Partial<RasterSourceSpecification> = {}) {
  if (map.getLayer(`base-${id}`)) removeBase(id, false);
  BASES[id] = def;
  const spec = { type: 'raster', tiles: def.tiles, tileSize: 256, maxzoom: def.max, attribution: def.attr, ...sourceSpec } as RasterSourceSpecification;
  map.addSource(id, spec);
  const layers = map.getStyle().layers;
  const bg = layers.findIndex((l) => l.id === 'bg');
  map.addLayer(
    { id: `base-${id}`, type: 'raster', source: id, layout: { visibility: id === S.map.base ? 'visible' : 'none' }, paint: { 'raster-brightness-max': baseBrightness() } },
    layers[bg + 1]?.id,
  );
}

/** Убрать подложку; если она была выбрана — откат на 'sat'. */
export function removeBase(id: string, apply = true) {
  if (map.getLayer(`base-${id}`)) map.removeLayer(`base-${id}`);
  if (map.getSource(id)) map.removeSource(id);
  delete BASES[id];
  if (apply) ensureBase();
}

/** Выбранной подложки нет (удалена/недоступна) — вернуть 'sat' и обновить стиль. */
export function ensureBase() {
  if (!BASES[S.map.base]) S.map.base = 'sat';
  applyMapStyle();
}

export function applyMapStyle() {
  for (const id of Object.keys(BASES)) {
    if (!map.getLayer(`base-${id}`)) continue;
    map.setLayoutProperty(`base-${id}`, 'visibility', id === S.map.base ? 'visible' : 'none');
    map.setPaintProperty(`base-${id}`, 'raster-brightness-max', baseBrightness());
  }
  map.setLayoutProperty('hillshade', 'visibility', S.map.hillshade ? 'visible' : 'none');
  for (const l of ['roads', 'places']) map.setLayoutProperty(l, 'visibility', S.map.labels ? 'visible' : 'none');
  document.body.classList.toggle('no-labels', !S.map.labels);
  persist();
}

/**
 * Цвета слоёв карты под тему: фон, яркость подложек, обводки линий связи/маршрутов (тёмная обводка —
 * чтобы линия читалась и на светлом топо, и на спутнике). Слои создают другие модули (live.ts, ruler.ts),
 * поэтому правим их по id, когда они появятся (styledata), и при смене темы. Ставим свойство, только если
 * значение отличается, — иначе styledata от setPaintProperty зациклился бы.
 */
/** Акцентный цвет темы (--accent) — для линий линейки и границы зоны на карте. */
export const accentColor = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || THEMES[resolvedTheme()].accent;

function overlayPaint(): Record<string, Record<string, unknown>> {
  const m = MAP_THEME[resolvedTheme()];
  const casing = { 'line-color': m.casing, 'line-opacity': m.casingOpacity };
  const accent = accentColor();
  return {
    bg: { 'background-color': m.bg },
    'ov-link-casing': { ...casing, 'line-width': 7 },
    'ov-link': { 'line-width': 4 },
    'ov-link-dash': { 'line-width': 4 },
    'ov-routes-casing': { ...casing, 'line-width': 6 },
    'ov-routes': { 'line-color': m.route },
    'ov-ruler': { 'line-color': accent },
    'ov-ruler-live': { 'line-color': accent },
    'ov-ruler-pts': { 'circle-stroke-color': m.casing, 'circle-color': accent },
    'cov-edge': { 'line-color': accent },
  };
}
function applyMapTheme() {
  // не isStyleLoaded(): он ложен, пока грузятся тайлы, а смену темы надо применить сразу. До загрузки стиля getLayer пуст.
  const setIf = (id: string, prop: string, v: unknown) => {
    if (JSON.stringify(map.getPaintProperty(id, prop)) !== JSON.stringify(v)) map.setPaintProperty(id, prop, v);
  };
  for (const [id, props] of Object.entries(overlayPaint())) {
    if (!map.getLayer(id)) continue;
    for (const [k, v] of Object.entries(props)) setIf(id, k, v);
  }
  for (const id of Object.keys(BASES)) if (map.getLayer(`base-${id}`)) setIf(`base-${id}`, 'raster-brightness-max', baseBrightness());
}
map.on('styledata', applyMapTheme);
window.addEventListener('uavmap:theme', applyMapTheme);

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
  document.body.classList.add('sheet-open'); // строка связи под шторкой прячется (styles/live.css)
  return b;
}
export function closeSheet() {
  $('sheet').hidden = true;
  document.body.classList.remove('sheet-open');
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

/** Простая шина событий между модулями. */
type Ev = 'station' | 'radio' | 'marks' | 'routes' | 'coords';
const subs = new Map<Ev, Set<() => void>>();
export const on = (e: Ev, f: () => void) => { if (!subs.has(e)) subs.set(e, new Set()); subs.get(e)!.add(f); };
export const emit = (e: Ev) => { persist(); subs.get(e)?.forEach((f) => f()); };
