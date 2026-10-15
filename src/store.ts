// Состояние проекта в localStorage + экспорт/импорт. Всё хранится только на устройстве.
import { DEFAULT_RADIO, DEFAULT_VIDEO, DEFAULT_VIDEO_PRESET, RadioParams } from './radio';
import type { CoordFormat } from './coords';
import type { ClutterClass } from './clutter';
import { escapeHtml as esc } from './format';
import { isObj, num, fin, oneOf } from './validate';

export interface Mark { id: string; name: string; note: string; lat: number; lon: number; color: string; folder: string; created: number }
export interface Route { id: string; name: string; pts: [number, number][] } // [lon, lat]

export interface Station { lat: number; lon: number; antH: number; name: string }

export interface State {
  v: number;
  marks: Mark[];
  routes: Route[];
  station: Station | null;
  droneH: number;
  altMode: 'takeoff' | 'terrain';
  radio: RadioParams;
  presetId: string;
  /** Вторая линия — видео. radio/presetId выше — линия «Управление» (формат прежних проектов). */
  video: { enabled: boolean; radio: RadioParams; presetId: string };
  /**
   * Зона покрытия. Высота показа — всегда S.droneH; heights — список «Сравнить высоты» (S.droneH в него
   * добавляется при расчёте, см. coverageHeights), compare — считать ли этот список.
   */
  coverage: { radius: number; compare: boolean; heights: number[]; show: 'margin' | 'minh'; opacity: number; line: 'rc' | 'video' | 'both' };
  map: { base: string; labels: boolean; hillshade: boolean; contours: boolean; dim: number; center: [number, number]; zoom: number };
  coordFormat: CoordFormat;
  clutter: ClutterClass;   // местность у пульта
}

const KEY = 'radius.project.v1';
/** Цвет новой метки по умолчанию. */
export const MARK_COLOR = '#e3a948';
/** Единый лимит высот зоны: и сохранённый список, и набор расчёта (вместе с S.droneH). */
export const COV_MAX_HEIGHTS = 8;

export const defaults = (): State => ({
  v: 2,
  marks: [],
  routes: [],
  station: null,
  droneH: 100,
  altMode: 'takeoff',
  radio: { ...DEFAULT_RADIO },
  presetId: 'elrs24',
  video: { enabled: true, radio: { ...DEFAULT_VIDEO }, presetId: DEFAULT_VIDEO_PRESET },
  coverage: { radius: 15000, compare: false, heights: [30, 60, 100, 150, 250, 400], show: 'margin', opacity: 0.6, line: 'both' },
  map: { base: 'sat', labels: true, hillshade: true, contours: true, dim: 0.35, center: [40.2045, 43.6805], zoom: 12 },
  coordFormat: 'sk42',
  clutter: 'open',
});

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(base)) return (over ?? base) as T;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

/**
 * Миграция сырых данных до слияния с defaults (иначе не отличить старый формат от нового).
 * Зона: прежние проекты считали весь список высот и показывали выбранную heightIdx. Теперь показ — S.droneH,
 * список остаётся «Сравнить высоты»: у старого проекта сравнение включено, если высот было больше одной.
 * v1 → v2: отмывка рельефа стала основой карты (горизонтали — редкие) — у старых проектов включаем её один раз:
 * там она была выключена по прежнему умолчанию, а не выбором пользователя.
 */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  let out: Record<string, unknown> = raw;
  if (isObj(raw.coverage)) {
    const c = { ...raw.coverage };
    if (typeof c.compare !== 'boolean' && ('heightIdx' in c || 'heights' in c)) c.compare = Array.isArray(c.heights) && c.heights.length > 1;
    delete c.heightIdx;
    out = { ...out, coverage: c };
  }
  if (!(typeof raw.v === 'number' && raw.v >= 2) && isObj(raw.map)) out = { ...out, map: { ...raw.map, hillshade: true } };
  return out;
}

/** В браузере ещё нет сохранённого состояния — первый запуск (до первого persist). */
export function firstRun(): boolean {
  try { return localStorage.getItem(KEY) === null; } catch { return false; }
}

export function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(merge(defaults(), migrate(JSON.parse(raw))));
  } catch { /* повреждённые данные — начинаем с чистого */ }
  return defaults();
}

const okLL = (lat: unknown, lon: unknown) => typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Радиопараметры из недоверенного источника: каждое поле — число в разумных пределах, иначе значение по умолчанию. */
function sanitizeRadio(src: unknown, def: RadioParams): RadioParams {
  const r: Record<string, unknown> = isObj(src) ? src : {};
  const out = { ...def };
  for (const k of Object.keys(def) as (keyof RadioParams)[]) out[k] = fin(r[k], -1e4, 1e6, def[k]);
  if (out.freqMHz <= 0) out.freqMHz = def.freqMHz;
  if (out.k <= 0) out.k = def.k;
  return out;
}

/** Не больше n элементов, равномерно по списку с сохранением первого и последнего (старые проекты — до 12 высот). */
function spread<T>(a: T[], n: number): T[] {
  if (a.length <= n) return a;
  return Array.from({ length: n }, (_, i) => a[Math.round((i * (a.length - 1)) / (n - 1))]);
}

/** Привести состояние из недоверенного источника (localStorage, файл копии) к корректному виду. */
export function sanitize(s: State): State {
  const d = defaults();
  const out: State = { ...d };
  out.marks = (Array.isArray(s.marks) ? s.marks : []).filter((m) => isObj(m) && okLL(m.lat, m.lon)).map((m) => ({
    id: typeof m.id === 'string' && m.id ? m.id.slice(0, 40) : uid(),
    name: str(m.name, 120) || 'Метка', note: str(m.note, 1000),
    lat: m.lat, lon: m.lon,
    color: typeof m.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(m.color) ? m.color : MARK_COLOR,
    folder: str(m.folder, 120), created: fin(m.created, 0, 1e14, Date.now()),
  }));
  out.routes = (Array.isArray(s.routes) ? s.routes : []).filter(isObj).map((r) => ({
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : uid(),
    name: str(r.name, 120) || 'Маршрут',
    pts: (Array.isArray(r.pts) ? r.pts : []).filter((p): p is [number, number] => Array.isArray(p) && okLL(p[1], p[0])).map((p) => [p[0], p[1]] as [number, number]),
  })).filter((r) => r.pts.length >= 2);
  const st = s.station;
  out.station = isObj(st) && okLL(st.lat, st.lon)
    ? { lat: st.lat as number, lon: st.lon as number, antH: fin(st.antH, 0, 1000, 2), name: str(st.name, 60) || 'Пульт' }
    : null;
  out.droneH = fin(s.droneH, 0, 10000, d.droneH);
  out.altMode = oneOf(s.altMode, ['takeoff', 'terrain'] as const, d.altMode);
  out.radio = sanitizeRadio(s.radio, d.radio);
  out.presetId = typeof s.presetId === 'string' ? s.presetId.slice(0, 40) : d.presetId;
  const v: Record<string, unknown> = isObj(s.video) ? s.video : {};
  out.video = {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.video.enabled,
    radio: sanitizeRadio(v.radio, d.video.radio),
    presetId: typeof v.presetId === 'string' ? v.presetId.slice(0, 40) : d.video.presetId,
  };
  const c: Record<string, unknown> = isObj(s.coverage) ? s.coverage : {};
  const heights = (Array.isArray(c.heights) ? c.heights : []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 10000);
  const sortedH = spread([...new Set(heights)].sort((a, b) => a - b), COV_MAX_HEIGHTS); // «нужная высота» требует возрастания
  out.coverage = {
    radius: fin(c.radius, 500, 100000, d.coverage.radius),
    compare: typeof c.compare === 'boolean' ? c.compare : d.coverage.compare,
    heights: Array.isArray(c.heights) ? sortedH : d.coverage.heights, // пустой список — сравнивать не с чем, это допустимо
    show: oneOf(c.show, ['margin', 'minh'] as const, d.coverage.show),
    opacity: fin(c.opacity, 0, 1, d.coverage.opacity),
    line: oneOf(c.line, ['rc', 'video', 'both'] as const, d.coverage.line),
  };
  const m: Record<string, unknown> = isObj(s.map) ? s.map : {};
  const ctr = Array.isArray(m.center) && okLL(m.center[1], m.center[0]) ? [m.center[0], m.center[1]] as [number, number] : d.map.center;
  out.map = {
    base: typeof m.base === 'string' ? m.base.slice(0, 20) : d.map.base,
    labels: typeof m.labels === 'boolean' ? m.labels : d.map.labels,
    hillshade: typeof m.hillshade === 'boolean' ? m.hillshade : d.map.hillshade,
    contours: typeof m.contours === 'boolean' ? m.contours : d.map.contours,
    dim: fin(m.dim, 0, 0.9, d.map.dim), center: ctr, zoom: fin(m.zoom, 0, 22, d.map.zoom),
  };
  out.coordFormat = oneOf(s.coordFormat, ['sk42', 'dd', 'dms'] as const, d.coordFormat);
  out.clutter = oneOf(s.clutter, ['open', 'sparse', 'village', 'forest'] as const, d.clutter);
  return out;
}

let timer = 0;
/** Отложенная запись проекта (300 мс). onError — запись не удалась (квота, запрет хранилища). */
export function save(s: State, onError?: (e: unknown) => void) {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { onError?.(e); }
  }, 300);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- Экспорт ----------

export function toGeoJSON(s: State) {
  const features: unknown[] = s.marks.map((m) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
    properties: { kind: 'mark', name: m.name, note: m.note, color: m.color, folder: m.folder },
  }));
  for (const r of s.routes) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.pts }, properties: { kind: 'route', name: r.name } });
  if (s.station) features.push({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.station.lon, s.station.lat] },
    properties: { kind: 'station', name: s.station.name, antH: s.station.antH },
  });
  return { type: 'FeatureCollection', features, properties: { app: 'radius', droneH: s.droneH, altMode: s.altMode, radio: s.radio, video: s.video } };
}

export function toGPX(s: State): string {
  const wpts = s.marks.map((m) => `<wpt lat="${m.lat}" lon="${m.lon}"><name>${esc(m.name)}</name><desc>${esc(m.note)}</desc></wpt>`);
  const trks = s.routes.map((r) => `<rte><name>${esc(r.name)}</name>${r.pts.map(([lon, lat]) => `<rtept lat="${lat}" lon="${lon}"/>`).join('')}</rte>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Radius" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts.join('\n')}\n${trks.join('\n')}\n</gpx>\n`;
}

export function toKML(s: State): string {
  const pm = s.marks.map((m) => `<Placemark><name>${esc(m.name)}</name><description>${esc(m.note)}</description><Point><coordinates>${m.lon},${m.lat}</coordinates></Point></Placemark>`);
  const ls = s.routes.map((r) => `<Placemark><name>${esc(r.name)}</name><LineString><coordinates>${r.pts.map((p) => p.join(',')).join(' ')}</coordinates></LineString></Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n${pm.join('\n')}\n${ls.join('\n')}\n</Document></kml>\n`;
}

// ---------- Импорт (данные из файла считаем недоверенными: только текст и числа) ----------

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

export function importText(text: string, name: string): { marks: Mark[]; routes: Route[] } {
  const marks: Mark[] = [], routes: Route[] = [];
  const addMark = (lat: number, lon: number, nm: string, note = '') => {
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      marks.push({ id: uid(), name: nm || 'Метка', note, lat, lon, color: MARK_COLOR, folder: name, created: Date.now() });
  };
  const addRoute = (pts: [number, number][], nm: string) => {
    const ok = pts.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    if (ok.length >= 2) routes.push({ id: uid(), name: nm || 'Маршрут', pts: ok });
  };

  const t = text.trimStart();
  if (t.startsWith('{')) {
    const gj = JSON.parse(t);
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [];
    for (const f of feats.slice(0, 20000)) {
      const g = f?.geometry, p = f?.properties || {};
      if (g?.type === 'Point') addMark(num(g.coordinates?.[1]), num(g.coordinates?.[0]), str(p.name, 120), str(p.note || p.description));
      if (g?.type === 'LineString') addRoute((g.coordinates || []).map((c: unknown[]) => [num(c[0]), num(c[1])]), str(p.name, 120));
    }
    return { marks, routes };
  }
  const doc = new DOMParser().parseFromString(t, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Не удалось разобрать XML');
  const txt = (el: Element | null) => (el?.textContent || '').trim().slice(0, 500);
  // Отсутствующий атрибут — NaN (а не 0, как дал бы +null), такая точка отбрасывается.
  const attr = (el: Element, n: string) => { const v = el.getAttribute(n); return v === null || v.trim() === '' ? NaN : Number(v); };
  // GPX
  doc.querySelectorAll('wpt').forEach((w) => addMark(attr(w, 'lat'), attr(w, 'lon'), txt(w.querySelector('name')), txt(w.querySelector('desc'))));
  doc.querySelectorAll('rte, trk').forEach((r) => addRoute(
    [...r.querySelectorAll('rtept, trkpt')].map((p) => [attr(p, 'lon'), attr(p, 'lat')]), txt(r.querySelector('name'))));
  // KML
  doc.querySelectorAll('Placemark').forEach((pm) => {
    const nm = txt(pm.querySelector('name')), desc = txt(pm.querySelector('description'));
    const pt = pm.querySelector('Point coordinates');
    if (pt) { const [lon, lat] = txt(pt).split(',').map(Number); addMark(lat, lon, nm, desc); }
    const ls = pm.querySelector('LineString coordinates');
    if (ls) addRoute((ls.textContent || '').trim().split(/\s+/).map((c) => c.split(',').map(Number) as [number, number]), nm);
  });
  return { marks, routes };
}

export function download(name: string, data: string | Blob, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Резервная копия проекта ----------

/** Немедленно записать проект (без задержки save). Ошибку записи (квота, запрет хранилища) пробрасывает. */
export function saveNow(s: State) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {
    throw new Error('Не удалось сохранить проект в браузере: не хватает места или хранилище недоступно');
  }
}

/** Удалить сохранённый проект из localStorage. */
export function clearSaved() {
  try { localStorage.removeItem(KEY); } catch { /* недоступно */ }
}

/** Разобрать резервную копию; при ошибке — исключение с понятным текстом. */
export function restoreProject(text: string): State {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Файл не похож на копию проекта (не JSON)'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Файл не похож на копию проекта');
  const r = raw as Record<string, unknown>;
  if (r.marks !== undefined && !Array.isArray(r.marks)) throw new Error('В копии повреждён список меток');
  if (r.routes !== undefined && !Array.isArray(r.routes)) throw new Error('В копии повреждён список маршрутов');
  return sanitize(merge(defaults(), migrate(raw)));
}
