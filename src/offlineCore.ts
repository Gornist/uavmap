// Офлайн-районы: чистые функции (перечень тайлов, план слоёв, разбор метаданных) — без DOM и карты.
import { demTileUrl, srcOf, DEM_SRC_ID } from './demTiles';
import { demPlan, coverageZoom, COVERAGE_RADII_KM } from './elevation';
import { R_EARTH, D2R, distance, LatLon } from './geo';
import { isObj, inRange as num } from './validate';

export const OFFLINE_CACHE = 'uavmap-dem-v1';
export const OFFLINE_KEY = 'uavmap.offline.v1';
/** Радиусы офлайн-района, км. */
export const RADII_KM = [5, 10, 20, 40];
/** Средний тайл источника (WebP 512 px; грубая оценка, уточняется замером). */
export const DEFAULT_TILE_BYTES = 110 * 1024;
/** Виртуальные уровни для карты (отмывка и горизонтали): им соответствуют тайлы источника z7..z12. */
export const VIEW_Z0 = 8, VIEW_Z1 = 13;
/** Уровни в сохранённых районах: до 15 — как у прежнего источника, чтобы старые районы не пропадали из списка. */
const LAYER_MAX_Z = 15;
const PAD_PX = 16; // запас по краю: окно максимума и билинейная выборка выходят за радиус

export interface Layer { z: number; km: number }
export interface Area {
  id: string; name: string; lat: number; lon: number; km: number;
  calc: boolean; view: boolean; layers: Layer[]; tiles: number; bytes: number; ts: number;
  /** Источник рельефа, с которого скачан район (DEM_SRC_ID); другой — район устарел, нужно «Обновить». */
  src: string;
  /** false — скачивание отменили или часть данных не загрузилась; нет поля (районы прежних версий) — полный. */
  complete?: boolean;
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

/**
 * Все тайлы источника для набора слоёв {z, km} вокруг точки: слои — в виртуальной сетке 256 px (как профиль и зона),
 * каждый виртуальный тайл переводится в тайл источника 512 px уровнем выше; без дублей, X обёрнут по антимеридиану.
 */
export function enumerateTiles(lat: number, lon: number, layers: Layer[]): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (const { z, km } of layers) {
    if (z < 1) continue;
    const n = 2 ** z;
    const r = tileRange(lat, lon, km, z);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let xr = r.x0; xr <= r.x1; xr++) {
        const s = srcOf(z, ((xr % n) + n) % n, y);
        const t = { z: s.z, x: s.x, y: s.y };
        const k = tileKey(t);
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      }
    }
  }
  return out;
}

/** Число тайлов источника для одного слоя (виртуальный уровень z). */
export function countTiles(lat: number, lon: number, km: number, z: number): number {
  return enumerateTiles(lat, lon, [{ z, km }]).length;
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
  return dedupLayers(out);
}

/** Слой (z, km) с тем же z и меньшим радиусом входит в больший — убираем дубли (порядок сохраняется). */
export function dedupLayers(out: Layer[]): Layer[] {
  return out.filter((a, i) => !out.some((b, j) => j !== i && b.z === a.z && (b.km > a.km || (b.km === a.km && j < i))));
}

// ---------- «Подготовить без сети» ----------

/** Радиус района «Подготовить без сети», км: радиус зоны (м), округлённый вверх до ближайшего из RADII_KM; больше наибольшего — наибольший. */
export function prepRadiusKm(radiusM: number): number {
  const km = radiusM / 1000;
  return RADII_KM.find((r) => r >= km - 1e-6) ?? RADII_KM[RADII_KM.length - 1];
}

/**
 * Район «Подготовить без сети» вокруг пульта: данные для расчёта и для карты радиусом prepRadiusKm и уровень рельефа
 * зоны ровно текущего радиуса (радиус зоны может быть не из COVERAGE_RADII_KM — тогда его уровня в planLayers нет).
 */
export function prepLayers(lat: number, lon: number, radiusM: number): { km: number; layers: Layer[] } {
  const km = prepRadiusKm(radiusM);
  const zoneKm = Math.min(radiusM / 1000, km);
  const zone = { z: coverageZoom({ lat, lon }, zoneKm * 1000).z, km: zoneKm };
  return { km, layers: dedupLayers([...planLayers(lat, lon, km, true, true), zone]) };
}

/**
 * Готовность к работе без сети у пульта: 'ready' — в одном полностью скачанном районе есть уровни рельефа зоны
 * (coverageZoom) и профиля (demPlan) радиуса radiusM вокруг пульта целиком; 'edge' — пульт в районе с данными расчёта,
 * но зона (или её уровень) выходит за скачанное; 'none' — пульт вне районов. Проверяются слои, а не внешний радиус:
 * уровень зоны в районе скачан на свой, меньший радиус вокруг центра района (planLayers).
 */
export function prepState(areas: Area[], st: LatLon, radiusM: number): 'ready' | 'edge' | 'none' {
  const usable = areas.filter((a) => a.calc && a.src === DEM_SRC_ID && a.complete !== false);
  const need = [coverageZoom(st, radiusM).z, demPlan(st.lat, radiusM).z];
  const has = (a: Area, z: number) => a.layers.some((l) => l.z === z && distance(a, st) + radiusM <= l.km * 1000 + 1);
  if (usable.some((a) => need.every((z) => has(a, z)))) return 'ready';
  return usable.some((a) => distance(a, st) <= a.km * 1000) ? 'edge' : 'none';
}

/** Итог скачивания района: done — скачано, skipped — уже было, errors — не загрузилось, sourceDown — источник не отвечает вовсе. */
export interface DownloadSummary { done: number; skipped: number; errors: number; aborted: boolean; sourceDown?: boolean }

/** Текст итога скачивания для пользователя; again — кнопка, которой докачать остальное. */
export function downloadVerdict(r: DownloadSummary, size: string, again: string): string {
  if (r.sourceDown) return `Скачано не всё — источник рельефа (Mapterhorn) не отвечает. Без сети расчёт здесь пока не работает. Попробуйте другую сеть (Wi‑Fi) и нажмите «${again}» ещё раз`;
  if (r.aborted) return `Скачивание отменено. Уже скачанное (${size}) сохранено — «${again}» докачает остальное`;
  if (r.errors) return `Скачано не всё (${size}): часть рельефа не загрузилась — без сети здесь местами будет «Нет данных рельефа». Когда будет сеть, нажмите «${again}» — докачается остальное`;
  return `Готово: ${size} — расчёт здесь работает без сети`;
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
      if (isObj(l) && num(l.z, 0, LAYER_MAX_Z) && Number.isInteger(l.z) && num(l.km, 0.1, 1000)) layers.push({ z: l.z, km: l.km }); else bad = true;
    }
    if (bad) continue;
    if (!num(a.tiles, 0, 1e7) || !num(a.bytes, 0, 1e12) || !num(a.ts, 0, 1e14)) continue;
    ids.add(a.id);
    out.push({ id: a.id, name: a.name.slice(0, 80), lat: a.lat, lon: a.lon, km: a.km, calc: a.calc === true, view: a.view === true, layers, tiles: a.tiles, bytes: a.bytes, ts: a.ts, src: typeof a.src === 'string' ? a.src.slice(0, 40) : 'aws', ...(a.complete === false ? { complete: false } : {}) });
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

/**
 * Покрыты ли точки (пульт, прицел) рельефом скачанных районов для расчёта: 'yes' — все точки внутри одного
 * полностью скачанного района с данными расчёта текущего источника; 'no' — хоть одна вне; 'none' — пригодных районов нет вовсе.
 */
export function areasCover(areas: Area[], points: LatLon[]): 'yes' | 'no' | 'none' {
  const usable = areas.filter((a) => a.calc && a.src === DEM_SRC_ID && a.complete !== false);
  if (!usable.length) return 'none';
  return usable.some((a) => points.every((p) => distance(a, p) <= a.km * 1000)) ? 'yes' : 'no';
}
