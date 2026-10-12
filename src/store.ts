// Состояние проекта в localStorage + экспорт/импорт. Всё хранится только на устройстве.
import { DEFAULT_RADIO, RadioParams } from './radio';
import type { CoordFormat } from './coords';

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
  coverage: { radius: number; heights: number[]; show: 'margin' | 'minh'; heightIdx: number; opacity: number };
  map: { base: string; labels: boolean; hillshade: boolean; dim: number; center: [number, number]; zoom: number };
  coordFormat: CoordFormat;
}

const KEY = 'radius.project.v1';

export const defaults = (): State => ({
  v: 1,
  marks: [],
  routes: [],
  station: null,
  droneH: 100,
  altMode: 'takeoff',
  radio: { ...DEFAULT_RADIO },
  presetId: 'elrs24',
  coverage: { radius: 15000, heights: [30, 60, 100, 150, 250, 400], show: 'margin', heightIdx: 2, opacity: 0.6 },
  map: { base: 'sat', labels: true, hillshade: false, dim: 0.35, center: [40.2045, 43.6805], zoom: 12 },
  coordFormat: 'sk42',
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

export function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(defaults(), JSON.parse(raw));
  } catch { /* повреждённые данные — начинаем с чистого */ }
  return defaults();
}

let timer = 0;
export function save(s: State) {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* квота */ }
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
  return { type: 'FeatureCollection', features, properties: { app: 'radius', droneH: s.droneH, altMode: s.altMode, radio: s.radio } };
}

const esc = (t: string) => t.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

export function importText(text: string, name: string): { marks: Mark[]; routes: Route[] } {
  const marks: Mark[] = [], routes: Route[] = [];
  const addMark = (lat: number, lon: number, nm: string, note = '') => {
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      marks.push({ id: uid(), name: nm || 'Метка', note, lat, lon, color: '#e3a948', folder: name, created: Date.now() });
  };
  const addRoute = (pts: [number, number][], nm: string) => {
    const ok = pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
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
  // GPX
  doc.querySelectorAll('wpt').forEach((w) => addMark(+w.getAttribute('lat')!, +w.getAttribute('lon')!, txt(w.querySelector('name')), txt(w.querySelector('desc'))));
  doc.querySelectorAll('rte, trk').forEach((r) => addRoute(
    [...r.querySelectorAll('rtept, trkpt')].map((p) => [+p.getAttribute('lon')!, +p.getAttribute('lat')!]), txt(r.querySelector('name'))));
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
