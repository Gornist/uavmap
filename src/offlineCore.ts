// Офлайн-районы: чистые функции (перечень тайлов, план слоёв, разбор метаданных) — без DOM и карты.
import { DEM_MAX_Z, demTileUrl } from './demTiles';
import { demPlan, coverageZoom, COVERAGE_RADII_KM } from './elevation';
import { R_EARTH, D2R } from './geo';
import { isObj, inRange as num } from './validate';

export const OFFLINE_CACHE = 'uavmap-dem-v1';
export const OFFLINE_KEY = 'uavmap.offline.v1';
/** Радиусы офлайн-района, км. */
export const RADII_KM = [5, 10, 20, 40];
/** Средний тайл Terrarium (грубая оценка, уточняется замером). */
export const DEFAULT_TILE_BYTES = 90 * 1024;
export const VIEW_Z0 = 8, VIEW_Z1 = 13; // maplibre-contour: maxzoom 13; hillshade берёт те же тайлы
const PAD_PX = 16; // запас по краю: окно максимума и билинейная выборка выходят за радиус

export interface Layer { z: number; km: number }
export interface Area {
  id: string; name: string; lat: number; lon: number; km: number;
  calc: boolean; view: boolean; layers: Layer[]; tiles: number; bytes: number; ts: number;
}
export interface Tile { z: number; x: number; y: number }

export const tileKey = (t: Tile) => `${t.z}/${t.x}/${t.y}`;
export const tileUrl = (t: Tile) => demTileUrl(t.z, t.x, t.y);

const MAX_LAT = 85.0511287798;

/** Диапазон тайлов, накрывающий круг радиуса km (+ запас). X не обёрнут (может выходить за [0, 2^z)), Y обрезан. */
export function tileRange(lat: number, lon: number, km: number, z: number): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** z;
  const dLat = (km * 1000) / R_EARTH / D2R;
  const cosL = Math.max(0.01, Math.cos(Math.min(Math.abs(lat) + dLat, 89.9) * D2R));
  const dLon = Math.min(180, dLat / cosL);
  const padT = PAD_PX / 256;
  const fx = (lo: number) => ((lo + 180) / 360) * n;
  const fy = (la: number) => {
    const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, la)) * D2R);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  };
  const x0 = Math.floor(fx(lon - dLon) - padT), x1 = Math.floor(fx(lon + dLon) + padT);
  const y0 = Math.max(0, Math.floor(fy(lat + dLat) - padT)), y1 = Math.min(n - 1, Math.floor(fy(lat - dLat) + padT));
  return { x0, x1: Math.min(x1, x0 + n - 1), y0, y1 };
}

/** Все тайлы набора слоёв {z, km} вокруг точки: без дублей, X обёрнут по антимеридиану. */
export function enumerateTiles(lat: number, lon: number, layers: Layer[]): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (const { z, km } of layers) {
    const n = 2 ** z;
    const r = tileRange(lat, lon, km, z);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let xr = r.x0; xr <= r.x1; xr++) {
        const t = { z, x: ((xr % n) + n) % n, y };
        const k = tileKey(t);
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      }
    }
  }
  return out;
}

export function countTiles(lat: number, lon: number, km: number, z: number): number {
  const r = tileRange(lat, lon, km, z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

export const estimateBytes = (tiles: number, avg = DEFAULT_TILE_BYTES) => Math.round(tiles * avg);

/** Слои района: «расчёт» (зум профиля/зоны для радиусов ≤ R) и «карта» (z 8..13 по bbox района). */
export function planLayers(lat: number, lon: number, km: number, calc: boolean, view: boolean): Layer[] {
  const out: Layer[] = [];
  if (calc) {
    out.push({ z: demPlan(lat, km * 1000).z, km }); // профиль до любой точки района
    for (const r of COVERAGE_RADII_KM.filter((v) => v <= km)) { // зона покрытия радиуса r — тот же уровень, что в coverageRun.ts
      out.push({ z: coverageZoom({ lat, lon }, r * 1000).z, km: r });
    }
  }
  if (view) for (let z = VIEW_Z0; z <= VIEW_Z1; z++) out.push({ z, km });
  // Слой (z, km) с тем же z и меньшим радиусом входит в больший — убираем дубли.
  return out.filter((a, i) => !out.some((b, j) => j !== i && b.z === a.z && (b.km > a.km || (b.km === a.km && j < i))));
}

/** Разбор метаданных из localStorage: повреждённое отбрасывается. */
export function parseAreas(raw: string | null): Area[] {
  if (!raw) return [];
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  const arr = isObj(j) && Array.isArray(j.areas) ? j.areas : Array.isArray(j) ? j : [];
  const out: Area[] = [];
  const ids = new Set<string>();
  for (const a of arr) {
    if (!isObj(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id) || typeof a.name !== 'string') continue;
    if (!num(a.lat, -90, 90) || !num(a.lon, -180, 180) || !num(a.km, 0.1, 1000)) continue;
    if (!Array.isArray(a.layers) || !a.layers.length) continue;
    const layers: Layer[] = [];
    let bad = false;
    for (const l of a.layers) {
      if (isObj(l) && num(l.z, 0, DEM_MAX_Z) && Number.isInteger(l.z) && num(l.km, 0.1, 1000)) layers.push({ z: l.z, km: l.km }); else bad = true;
    }
    if (bad) continue;
    if (!num(a.tiles, 0, 1e7) || !num(a.bytes, 0, 1e12) || !num(a.ts, 0, 1e14)) continue;
    ids.add(a.id);
    out.push({ id: a.id, name: a.name.slice(0, 80), lat: a.lat, lon: a.lon, km: a.km, calc: a.calc === true, view: a.view === true, layers, tiles: a.tiles, bytes: a.bytes, ts: a.ts });
  }
  return out;
}

/** Ключи тайлов района, которые не нужны ни одному другому району. */
export function exclusiveKeys(area: Area, others: Area[]): string[] {
  const used = new Set<string>();
  for (const o of others) for (const t of enumerateTiles(o.lat, o.lon, o.layers)) used.add(tileKey(t));
  return enumerateTiles(area.lat, area.lon, area.layers).map(tileKey).filter((k) => !used.has(k));
}

export const keyToUrl = (k: string) => { const [z, x, y] = k.split('/'); return tileUrl({ z: +z, x: +x, y: +y }); };
