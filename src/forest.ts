// Лес на трассе: маска «лес / не лес» из векторных тайлов OpenFreeMap (схема OpenMapTiles, слой landcover,
// class = wood — лес OSM), растеризованная в сетку тайлов рельефа (TILE × TILE на виртуальный тайл уровня z).
// Из маски — полог над рельефом вдоль трассы (radio.ts: дифракция над кронами и затухание сквозь них, P.833)
// и полог в сетке зоны (только дифракция над кронами). Разведка и обоснование — docs/FOREST.md.
//
// Рельеф Copernicus GLO-30 — модель поверхности: радар X-диапазона частично «видит» кроны, поэтому к рельефу
// добавляется только остаток полога: DSM_CANOPY_K × высота леса из настроек.
// Лес не пришёл (сеть, таймаут) — считаем без него и честно говорим «лес не учтён»; рельеф лес не ждёт дольше wait.
import { S, emit } from './app';
import { fetchBuffer, HttpStatusError } from './netTiles';
import { interpolate, lonLatToPixel, LatLon } from './geo';
import { TILE } from './demTiles';
import type { DemGrid } from './elevation';
import type { Rings } from './forestCore';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
/** Наибольший уровень векторных тайлов OpenMapTiles: глубже — вырезка из тайла этого уровня. */
export const VZ = 14;
/** Зона — по обобщённым контурам на 2 уровня крупнее: в 16 раз меньше тайлов, для километровой сетки хватает. */
const ZONE_COARSER = 2;
/**
 * Таймаут тайла — долгий: на пульте без VPN тайл OpenFreeMap (Cloudflare) приходит за ~10 с (проверено: 27 КБ за
 * 10,4 с). Расчёт его не ждёт (wait у forestProfile / forestIntoGrid) — тайл догружается в фоне, кладётся в кеш
 * Service Worker, и строка связи с зоной пересчитываются с лесом (событие 'forest').
 */
const TIMEOUT_MS = 25000;
/** Остаток полога над рельефом-поверхностью (TanDEM-X ниже верха крон на 5–12 м; FOREST.md, § 1). Калибруется по полётам. */
export const DSM_CANOPY_K = 0.5;

/** Полог над рельефом, м: остаток высоты леса из настроек. */
export const canopyHeight = () => S.forest.height * DSM_CANOPY_K;

// ---------- Предохранитель ----------
// Два сбоя подряд — 5 минут без запросов: не задерживать каждый расчёт таймаутами (как у рельефа, demNet.ts).
let fails = 0, offUntil = 0;
const down = () => Date.now() < offUntil;
function report(ok: boolean) {
  if (ok) { fails = 0; offUntil = 0; return; }
  if (++fails >= 2) { fails = 0; offUntil = Date.now() + 5 * 60 * 1000; }
}

// ---------- Векторные тайлы ----------
let template: Promise<string | null> | null = null;

/** Шаблон адреса тайлов из TileJSON (в нём версия набора данных). null — не получили, попробуем позже. */
function tileTemplate(): Promise<string | null> {
  if (!template) {
    template = fetchBuffer(TILEJSON, undefined, TIMEOUT_MS, 1).then((b) => {
      const t = (JSON.parse(new TextDecoder().decode(b)) as { tiles?: unknown }).tiles;
      const u = Array.isArray(t) ? t[0] : null;
      if (typeof u !== 'string' || !u.startsWith('https://tiles.openfreemap.org/')) throw new Error('TileJSON без tiles');
      return u;
    }).catch(() => { template = null; report(false); return null; });
  }
  return template;
}

const vecCache = new Map<string, Promise<Rings | null>>();
const VEC_MAX = 48;

/** Контуры леса векторного тайла; [] — леса нет, null — тайл не получили (сеть). */
function vecTile(z: number, x: number, y: number): Promise<Rings | null> {
  const key = `${z}/${x}/${y}`;
  let p = vecCache.get(key);
  if (p) { vecCache.delete(key); vecCache.set(key, p); return p; }
  p = (async () => {
    if (down()) return null;
    const t = await tileTemplate();
    if (!t) return null;
    try {
      const buf = await fetchBuffer(t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), undefined, TIMEOUT_MS, 1);
      report(true);
      // Разбор MVT (@mapbox/vector-tile + pbf, ~20 КБ) — отдельным чанком: не утяжеляет запуск.
      return (await import('./forestCore')).woodRings(buf);
    } catch (e) {
      // Тайла нет (404/410) — нет и леса. Остальное (429 «слишком часто», 403, 5xx, сеть) — данных нет:
      // «лес не учтён» и повтор позже, а не «леса нет» (иначе запас связи вышел бы завышенным).
      if (e instanceof HttpStatusError && (e.status === 404 || e.status === 410)) return [];
      report(false);
      return null;
    }
  })();
  const q = p;
  q.then((r) => { if (r === null && vecCache.get(key) === q) vecCache.delete(key); });
  vecCache.set(key, q);
  while (vecCache.size > VEC_MAX) vecCache.delete(vecCache.keys().next().value!);
  return q;
}

// ---------- Маска в сетке рельефа ----------
/** Маска TILE × TILE (1 — лес); EMPTY — общий пустой (не держим тысячи нулевых массивов). */
const EMPTY = new Uint8Array(0);
const maskCache = new Map<string, Promise<Uint8Array | null>>();
const MASK_MAX = 192; // ×64 КБ = 12 МБ

let cv: HTMLCanvasElement | null = null;

/** Растеризация колец (доли векторного тайла vz/vx/vy) в маску виртуального тайла z/x/y. */
export function rasterize(rings: Rings, z: number, x: number, y: number, vz: number): Uint8Array {
  if (!rings.length) return EMPTY;
  const k = 2 ** (z - vz), ox = x - Math.floor(x / k) * k, oy = y - Math.floor(y / k) * k;
  if (!cv) cv = Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, TILE, TILE);
  // Доля векторного тайла u → пиксель маски: (u·k − ox)·TILE.
  ctx.setTransform(k * TILE, 0, 0, k * TILE, -ox * TILE, -oy * TILE);
  ctx.beginPath();
  for (const r of rings) {
    ctx.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
    ctx.closePath();
  }
  ctx.fillStyle = '#000';
  ctx.fill('nonzero'); // внешние кольца MVT — по часовой, дыры — против: nonzero вырезает дыры
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Uint8Array(TILE * TILE);
  let any = false;
  for (let i = 0, j = 3; i < out.length; i++, j += 4) if (px[j] > 127) { out[i] = 1; any = true; }
  return any ? out : EMPTY;
}

/** Маска леса виртуального тайла z/x/y (векторные тайлы уровня vz ≤ z); null — данные не получили. */
function mask(z: number, x: number, y: number, vz: number): Promise<Uint8Array | null> {
  const key = `${z}/${x}/${y}/${vz}`;
  const p = maskCache.get(key);
  if (p) { maskCache.delete(key); maskCache.set(key, p); return p; }
  const k = 2 ** (z - vz);
  const q = vecTile(vz, Math.floor(x / k), Math.floor(y / k)).then((r) => (r ? rasterize(r, z, x, y, vz) : null));
  q.then((m) => { if (!m && maskCache.get(key) === q) maskCache.delete(key); });
  maskCache.set(key, q);
  while (maskCache.size > MASK_MAX) maskCache.delete(maskCache.keys().next().value!);
  return q;
}

export type ForestState = 'off' | 'ok' | 'missing';

/** Маски нужных тайлов, не дольше wait мс. Не успели — null; когда догрузятся, событие 'forest' (пересчитать). */
async function masks(need: Map<string, [number, number]>, z: number, vz: number, wait: number): Promise<Map<string, Uint8Array> | null> {
  const got = new Map<string, Uint8Array>();
  let missing = false;
  const all = Promise.all([...need].map(([key, [tx, ty]]) => mask(z, tx, ty, vz).then((m) => { if (m) got.set(key, m); else missing = true; })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inTime = await Promise.race([all.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), wait); })]);
  clearTimeout(timer);
  if (!inTime) {
    // Догрузятся — пересчитать с лесом (строка связи, высотомер). Не догрузятся (сбой) — так и останется «не учтён».
    void all.then(() => { if (!missing) emit('forest'); });
    return null;
  }
  return missing ? null : got;
}

/**
 * Полог вдоль трассы a → b для профиля из n+1 отсчётов уровня z (окна — как у profile() в elevation.ts):
 * отсчёт — лес, если лес есть где-то в его окне (рельеф в окне тоже берётся по максимуму). Концы — 0.
 */
export async function forestProfile(a: LatLon, b: LatLon, n: number, z: number, wait: number): Promise<{ canopy: Float32Array | null; state: ForestState }> {
  if (!S.forest.on) return { canopy: null, state: 'off' };
  const vz = Math.min(z, VZ);
  // Точки проверки: по 3 на окно отсчёта (начало, середина, конец) — окно не больше пары пикселей маски.
  const pts: [number, number][][] = [];
  const need = new Map<string, [number, number]>();
  for (let i = 1; i < n; i++) {
    const row: [number, number][] = [];
    for (const t of [(i - 0.5) / n, i / n, (i + 0.5) / n]) {
      const p = interpolate(a, b, t);
      const [px, py] = lonLatToPixel(p.lon, p.lat, z);
      const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
      need.set(`${tx}/${ty}`, [tx, ty]);
      row.push([px, py]);
    }
    pts.push(row);
  }
  const got = await masks(need, z, vz, wait);
  if (!got) return { canopy: null, state: 'missing' };
  const h = canopyHeight();
  const out = new Float32Array(n + 1);
  pts.forEach((row, i) => {
    for (const [px, py] of row) {
      const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
      const m = got.get(`${tx}/${ty}`)!;
      if (m.length && m[Math.min(TILE - 1, Math.floor(py - ty * TILE)) * TILE + Math.min(TILE - 1, Math.floor(px - tx * TILE))]) { out[i + 1] = h; break; }
    }
  });
  return { canopy: out, state: 'ok' };
}

/**
 * Полог в сетке зоны: к рельефу под лесом прибавляется остаток крон (дифракция над пологом). Меняет grid.data.
 * Контуры — на ZONE_COARSER уровней крупнее (обобщённые), чтобы не качать сотни тайлов.
 */
export async function forestIntoGrid(g: DemGrid, wait: number): Promise<ForestState> {
  if (!S.forest.on) return 'off';
  const vz = Math.max(0, Math.min(g.z, VZ) - ZONE_COARSER);
  const tx0 = g.px0 / TILE, ty0 = g.py0 / TILE, cols = g.width / TILE, rows = g.height / TILE;
  const need = new Map<string, [number, number]>();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) need.set(`${tx0 + c}/${ty0 + r}`, [tx0 + c, ty0 + r]);
  const got = await masks(need, g.z, vz, wait);
  if (!got) return 'missing';
  const h = canopyHeight();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = got.get(`${tx0 + c}/${ty0 + r}`)!;
    if (!m.length) continue;
    for (let y = 0; y < TILE; y++) {
      const row = (r * TILE + y) * g.width + c * TILE;
      for (let x = 0; x < TILE; x++) if (m[y * TILE + x]) g.data[row + x] += h;
    }
  }
  return 'ok';
}
