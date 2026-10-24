// Общее ядро: состояние, карта, мелкие помощники интерфейса.
import maplibregl, { Map as MLMap, StyleSpecification, RasterSourceSpecification } from 'maplibre-gl';
import { load, save, firstRun, State } from './store';
import { HILLSHADE_DEM_URL } from './demSource';
import { DEM_ATTRIBUTION, SRC_MAX_Z, SRC_TILE } from './demTiles';
import { reliable, NET_PROTO, netProtocol, VEC_PROTO, vecProtocol, GLYPH_PROTO, glyphProtocol, setVecHealth } from './netTiles';
import { labelsSource, labelLayers, labelPaint, vectorAllowed, labelHealth } from './labels';
import type { LatLon } from './geo';
import { initTheme, resolvedTheme, MAP_THEME, THEMES } from './theme';

// Тема должна стоять до создания карты (цвет фона, яркость подложки). Повторный вызов из main.ts безопасен.
initTheme();

const FIRST_RUN = firstRun();
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

/**
 * Отмывка и горизонтали под подложку. Цвет нейтральный (белый на спутнике, тёмно-коричневый на светлых топо/схеме):
 * жёлтый и красный на карте остаются за связью. Отмывка на спутнике мягче — у снимка свои тени.
 */
function reliefPaint(): Record<string, Record<string, unknown>> {
  const sat = S.map.base === 'sat';
  const ink = sat ? '#ffffff' : '#4a3a2a';
  return {
    hillshade: sat
      ? { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0, 0, 0, 0.6)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.22)' }
      : { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': 'rgba(40, 30, 20, 0.55)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.35)' },
    'contours-line': { 'line-color': ink, 'line-opacity': sat ? 0.2 : 0.3 },
    'contours-line-major': { 'line-color': ink, 'line-opacity': sat ? 0.5 : 0.55 },
    'contours-label': { 'text-color': sat ? 'rgba(255, 255, 255, 0.9)' : '#3d2f22', 'text-halo-color': sat ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.85)' },
  };
}

// до создания карты
maplibregl.addProtocol(NET_PROTO, netProtocol);
maplibregl.addProtocol(VEC_PROTO, vecProtocol);
maplibregl.addProtocol(GLYPH_PROTO, glyphProtocol);

/** WebGL только программный (нет драйвера GPU): обычный контекст создаётся, а с failIfMajorPerformanceCaveat — нет. */
function softwareGL(): boolean {
  const get = (opts?: WebGLContextAttributes) => {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2', opts) || c.getContext('webgl', opts)) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // проверочный контекст не держим
    return !!gl;
  };
  try {
    return !get({ failIfMajorPerformanceCaveat: true }) && get();
  } catch {
    return false;
  }
}

/** Графика без GPU: отмывку (самый тяжёлый слой) по умолчанию не включаем — только на первом запуске, дальше выбор пользователя. */
export const SOFT_GL = softwareGL();
if (SOFT_GL && FIRST_RUN) S.map.hillshade = false;

/** Подписи векторные (labels.ts); false — растровые Esri: векторные недавно не приходили или отказали в этом сеансе. */
let vecLabels = vectorAllowed();
const rasterLabelsOn = () => S.map.labels && !vecLabels;

/** Проявление новых тайлов: короче стандартных 300 мс — карта появляется быстрее, но без резкого мигания. */
const FADE_MS = 150;

/** Яркость подложки: пользовательское затемнение × приглушение ночной темы. */
const baseBrightness = () => (1 - S.map.dim) * MAP_THEME[resolvedTheme()].baseBrightness;

function style(): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    // Mapterhorn: тайлы 512 px до z12 (детальность прежних 256 px z13); на крупных масштабах MapLibre растягивает z12.
    // Тайлы — из общего источника (demSource.ts): отмывка не качает их второй раз после горизонталей и расчётов.
    dem: { type: 'raster-dem', tiles: [HILLSHADE_DEM_URL], tileSize: SRC_TILE, maxzoom: SRC_MAX_Z, encoding: 'terrarium', attribution: DEM_ATTRIBUTION },
    // Запасные подписи (растр Esri): пока векторные работают, слои скрыты и тайлы не грузятся.
    // Растровые тайлы — через загрузчик с таймаутом (netTiles.ts): зависший запрос не держит тайл минутами.
    roads: { type: 'raster', tiles: [reliable('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}')], tileSize: 256, maxzoom: 19 },
    places: { type: 'raster', tiles: [reliable('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}')], tileSize: 256, maxzoom: 19 },
  };
  if (vecLabels) sources.labels = labelsSource();
  const layers: StyleSpecification['layers'] = [{ id: 'bg', type: 'background', paint: { 'background-color': MAP_THEME[resolvedTheme()].bg } }];
  for (const [id, b] of Object.entries(BASES)) {
    sources[id] = { type: 'raster', tiles: b.tiles.map(reliable), tileSize: 256, maxzoom: b.max, attribution: b.attr };
    layers.push({ id: `base-${id}`, type: 'raster', source: id, layout: { visibility: id === S.map.base ? 'visible' : 'none' }, paint: { 'raster-brightness-max': baseBrightness(), 'raster-fade-duration': FADE_MS } });
  }
  layers.push(
    { id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: S.map.hillshade ? 'visible' : 'none' }, paint: reliefPaint().hillshade as Record<string, string | number> },
    { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: rasterLabelsOn() ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': FADE_MS } },
    { id: 'places', type: 'raster', source: 'places', layout: { visibility: rasterLabelsOn() ? 'visible' : 'none' }, paint: { 'raster-fade-duration': FADE_MS } },
    ...(vecLabels ? labelLayers(S.map.base === 'sat', S.map.labels) : []),
  );
  // Глифы подписей (горизонтали, названия) — свои, в public/fonts: тот же сервер, офлайн-кеш оболочки.
  // С внешнего сервера на старте глиф мог не прийти, и в старом Chrome его ошибку нельзя переслать воркеру
  // MapLibre (DataCloneError) — тогда все тайлы с подписями ждали его вечно. Протокол GLYPH_PROTO отдаёт
  // отсутствующий диапазон символов пустым, а не ошибкой.
  const glyphs = `${GLYPH_PROTO}://${location.host}${import.meta.env.BASE_URL}fonts/{fontstack}/{range}.pbf`;
  return { version: 8, glyphs, sources, layers };
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
  // Плотность отрисовки не выше 2: растровые тайлы на 3× чётче не станут, а GPU рисовал бы в 2,25 раза больше пикселей.
  // Без аппаратного WebGL (программная отрисовка) — 1: на таком устройстве это главная экономия.
  pixelRatio: SOFT_GL ? 1 : Math.min(window.devicePixelRatio || 1, 2),
  renderWorldCopies: false, // одна копия мира — меньше тайлов на мелких масштабах
  fadeDuration: FADE_MS, // подписи горизонталей
});
map.touchZoomRotate.disableRotation();

/** Векторные подписи не приходят — убрать их источник (больше не ждать таймаутов) и показать растровые Esri. */
function fallbackToRasterLabels() {
  vecLabels = false;
  const swap = () => {
    for (const l of map.getStyle().layers) if (l.id.startsWith('lbl-')) map.removeLayer(l.id);
    if (map.getSource('labels')) map.removeSource('labels');
    applyMapStyle();
  };
  if (map.style?._loaded) swap(); else map.once('style.load', swap);
}
setVecHealth(labelHealth(fallbackToRasterLabels));
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
    { id: `base-${id}`, type: 'raster', source: id, layout: { visibility: id === S.map.base ? 'visible' : 'none' }, paint: { 'raster-brightness-max': baseBrightness(), 'raster-fade-duration': FADE_MS } },
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
  for (const l of ['roads', 'places']) map.setLayoutProperty(l, 'visibility', rasterLabelsOn() ? 'visible' : 'none');
  const sat = S.map.base === 'sat';
  for (const [id, paint] of Object.entries(labelPaint(sat))) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', S.map.labels ? 'visible' : 'none');
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty(id, k, v);
  }
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
    ...reliefPaint(),
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
  document.body.classList.add('sheet-open'); // строка связи и высотомер под шторкой прячутся (styles/layout.css)
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

/**
 * Простая шина событий между модулями. station — пульт (место, высота антенны, рельеф под ним);
 * radio — радиопараметры линий (аппаратура, пресеты, местность у пульта, видео вкл/выкл);
 * height — высота дрона S.droneH; antenna — антенны на земле (тип, усиление, ширина луча, азимут);
 * offline — список офлайн-районов изменился (скачан, удалён).
 */
type Ev = 'station' | 'radio' | 'height' | 'antenna' | 'marks' | 'routes' | 'coords' | 'offline' | 'forest';
const subs = new Map<Ev, Set<() => void>>();
export const on = (e: Ev, f: () => void) => { if (!subs.has(e)) subs.set(e, new Set()); subs.get(e)!.add(f); };
export const emit = (e: Ev) => { persist(); subs.get(e)?.forEach((f) => f()); };
