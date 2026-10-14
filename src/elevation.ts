// Высоты рельефа из открытых тайлов Terrarium (Mapzen/AWS Open Data, SRTM/ASTER/GMTED и др.).
// Значение = R*256 + G + B/256 − 32768 (метры над уровнем моря).
import { LatLon, lonLatToPixel, interpolate, destination, R_EARTH, D2R } from './geo';
import { DEM_MAX_Z, SHARED_DEM_MAX_Z, TILE, demTileUrl, demTileSpan, demTileCount } from './demTiles';

// Кеш тайлов — LRU по порядку Map: при обращении тайл переставляется в конец, вытесняется самый давний.
// 200 тайлов × 256 КБ (Float32 256×256) ≈ 50 МБ. Мозаику зоны (до 256 тайлов) держат свои ссылки — кеш её не ограничивает.
const CACHE_MAX = 200;
const cache = new Map<string, Promise<Float32Array | null>>();

/** Свой источник высот тайла (например, из HGT пользователя). null — нет покрытия, идём в сеть. */
export type LocalDemProvider = (z: number, x: number, y: number) => Promise<Float32Array | null> | Float32Array | null;
let localDem: LocalDemProvider | null = null;

/**
 * Общий источник тайлов до z13 (demSource.ts регистрирует его на странице): тайл, который уже скачал и разобрал
 * воркер горизонталей/отмывки, не качаем и не разбираем второй раз. В воркере зоны и в тестах его нет — свой fetch.
 */
export type SharedDem = (z: number, x: number, y: number) => Promise<{ width: number; height: number; data: Float32Array }>;
let sharedDem: SharedDem | null = null;
export function setSharedDem(fn: SharedDem | null) { sharedDem = fn; }

/** Сбросить кеш тайлов (после смены своих данных рельефа). */
function clearDemCache() { cache.clear(); }

/** Подключить/отключить провайдера локальных высот; кеш сбрасывается. */
export function setLocalDemProvider(fn: LocalDemProvider | null) {
  localDem = fn;
  clearDemCache();
}

// На слабой мобильной сети отдельный запрос может зависнуть навсегда — без таймаута вся загрузка зоны
// стоит на «35/36». Зависший или оборванный запрос повторяем один раз; ответ сервера с ошибкой — нет.
const NET_TIMEOUT_MS = 10000;
const NET_TRIES = 2;

function fetchBlob(url: string): Promise<Blob> {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac?.abort(); rej(new Error('timeout')); }, NET_TIMEOUT_MS); });
  const req = fetch(url, ac ? { signal: ac.signal } : undefined)
    .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)));
  return Promise.race([req, timeout]).then(
    (b) => { clearTimeout(timer); return b; },
    (e) => { clearTimeout(timer); throw e; },
  );
}

/** Сколько ждать общий источник, прежде чем параллельно идти своим запросом. */
const SHARED_WAIT_MS = 250;

/** Свой запрос со страницы (видит Service Worker и офлайн-кеш); один повтор при зависании/обрыве. */
async function ownFetch(z: number, x: number, y: number): Promise<Float32Array | null> {
  const url = demTileUrl(z, x, y);
  for (let i = 0; i < NET_TRIES; i++) {
    try {
      return decode(await createImageBitmap(await fetchBlob(url)));
    } catch (e) {
      if (typeof e === 'number') return null; // HTTP-статус: тайла нет, повтор не поможет
    }
  }
  return null;
}

/** Первый непустой результат из двух; null — если оба пустые. */
function firstOf(a: Promise<Float32Array | null>, b: Promise<Float32Array | null>): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    let left = 2;
    const take = (v: Float32Array | null) => { if (v) resolve(v); else if (--left === 0) resolve(null); };
    a.then(take); b.then(take);
  });
}

async function fromNetwork(z: number, x: number, y: number): Promise<Float32Array | null> {
  if (!sharedDem || z > SHARED_DEM_MAX_Z) return ownFetch(z, x, y);
  // До z13 — общий источник: тайл уже мог скачать и разобрать воркер горизонталей/отмывки, разбор не в главном потоке.
  // Не отдал (сбой или старый Chrome: воркер из blob не видит Service Worker и офлайн-кеш) — свой запрос.
  // Ответ общего источника ограничен по времени: воркер мог его потерять — тогда «нет» вместо вечного ожидания.
  const shared = Promise.race([
    sharedDem(z, x, y).then((t) => (t.width === TILE && t.height === TILE ? t.data : null), () => null),
    new Promise<null>((r) => setTimeout(() => r(null), NET_TIMEOUT_MS)),
  ]);
  const quick = await Promise.race([shared, new Promise<undefined>((r) => setTimeout(r, SHARED_WAIT_MS))]);
  if (quick) return quick;
  if (quick === null) return ownFetch(z, x, y);
  // Воркер занят горизонталями и отмывкой нового участка — трасса не ждёт его очередь: свой запрос параллельно, кто первый.
  return firstOf(shared, ownFetch(z, x, y));
}

function decode(img: ImageBitmap): Float32Array {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
  return out;
}

function getTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); } else {
    const local = localDem ? Promise.resolve().then(() => localDem!(z, x, y)).catch(() => null) : Promise.resolve(null);
    const q: Promise<Float32Array | null> = local.then((t) => t ?? fromNetwork(z, x, y)).then((t) => { if (!t && cache.get(key) === q) cache.delete(key); return t; });
    p = q;
    cache.set(key, p);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Часть тайлов рельефа не загрузилась: считать по нулям нельзя — вердикт был бы ложным. */
export class DemMissingError extends Error {
  constructor(public tiles: number) {
    super(`Нет данных рельефа (${tiles} тайл.) — проверьте интернет или офлайн-карты`);
    this.name = 'DemMissingError';
  }
}

/** Мозаика высот, склеенная из тайлов: удобно передавать в воркер одним массивом. */
export interface DemGrid {
  z: number; px0: number; py0: number; // левый верхний угол в глобальных пикселях
  width: number; height: number;
  data: Float32Array;
}

/** onTile(готово, всего) — после каждого тайла (для индикатора загрузки). */
export async function fetchGrid(points: LatLon[], z: number, pad = 2, onTile?: (done: number, total: number) => void): Promise<DemGrid> {
  const { tx0, tx1, ty0, ty1 } = demTileSpan(points, z, pad);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const width = cols * TILE, height = rows * TILE;
  const data = new Float32Array(width * height);
  const jobs: Promise<void>[] = [];
  let missing = 0, done = 0;
  const total = cols * rows;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(getTile(z, tx, ty).then((t) => {
      onTile?.(++done, total);
      if (!t) { missing++; return; }
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let r = 0; r < TILE; r++) data.set(t.subarray(r * TILE, r * TILE + TILE), (oy + r) * width + ox);
    }));
  }
  await Promise.all(jobs);
  if (missing) throw new DemMissingError(missing);
  return { z, px0: tx0 * TILE, py0: ty0 * TILE, width, height, data };
}

/** Билинейная выборка из мозаики по глобальным пикселям. */
export function sampleGrid(g: DemGrid, gx: number, gy: number): number {
  const x = Math.min(Math.max(gx - g.px0 - 0.5, 0), g.width - 1.001);
  const y = Math.min(Math.max(gy - g.py0 - 0.5, 0), g.height - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = y0 * g.width + x0, d = g.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.width] * (1 - fx) + d[i + g.width + 1] * fx) * fy;
}

/** Высота в точке или null, если рельеф недоступен. */
export async function elevationAt(p: LatLon, z = SHARED_DEM_MAX_Z): Promise<number | null> {
  // Нет тайла на z (например, офлайн: районы качаются до z13–z12) — пробуем уровни грубее.
  for (let zz = z; zz >= Math.min(z, 11); zz--) {
    try {
      const g = await fetchGrid([p], zz, 1);
      const [x, y] = lonLatToPixel(p.lon, p.lat, zz);
      return sampleGrid(g, x, y);
    } catch (e) {
      if (!(e instanceof DemMissingError)) throw e;
    }
  }
  return null;
}

// ---------- Выборка «максимум в окне» ----------
// Билинейная выборка срезает вершины хребтов (оптимистично для радиорасчёта), поэтому отсчёт трассы
// с шагом step = максимум узлов DEM в окне вдоль луча ±step/2 (узлы берём каждые 0.5 px; поперёк луча —
// ближайший узел, т.е. ±0.5 px: окно у́же пикселя смысла не имеет, шире — завышало бы препятствия на склонах).
// Концы трассы (антенны) — билинейно в самой точке: иначе пульт «встанет» на соседнюю кочку.


type Read = (ix: number, iy: number) => number; // значение узла (индексы узлов, не пикселей)

/** Билинейно в точке (u, v) в координатах узлов. */
function bilin(read: Read, u: number, v: number): number {
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  return (read(x0, y0) * (1 - fx) + read(x0 + 1, y0) * fx) * (1 - fy) + (read(x0, y0 + 1) * (1 - fx) + read(x0 + 1, y0 + 1) * fx) * fy;
}

/** Максимум узлов вдоль отрезка (a → b) в координатах узлов, шаг подвыборки 0.5 px. */
function segMax(read: Read, ax: number, ay: number, bx: number, by: number): number {
  const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
  let best = -Infinity;
  for (let j = 0; j <= m; j++) {
    const t = j / m;
    const v = read(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t));
    if (v > best) best = v;
  }
  return best;
}

// Узел луча (координаты узлов мозаики) на расстоянии d — без аллокаций, результат в RX/RY.
let RX = 0, RY = 0;
function rayNode(g: DemGrid, sf: number, cf: number, st: number, ct: number, l1: number, d: number) {
  const dd = d / R_EARTH, sd = Math.sin(dd), cd = Math.cos(dd);
  const s2 = sf * cd + cf * sd * ct;
  const l2 = l1 + Math.atan2(st * sd * cf, cd - sf * s2);
  const n = 256 * 2 ** g.z;
  RX = ((l2 / D2R + 180) / 360) * n - g.px0 - 0.5;
  RY = (0.5 - Math.log((1 + s2) / (1 - s2)) / (4 * Math.PI)) * n - g.py0 - 0.5;
}

/**
 * Высоты вдоль луча из пульта: out[0] — билинейно в точке пульта, out[k] (k = 1..nS-1) — максимум
 * в окне ±step/2 вокруг расстояния k·step (у out[1] окно начинается от пульта). Азимут — начальный (дуга большого круга).
 */
export function sampleRay(g: DemGrid, lat: number, lon: number, azDeg: number, step: number, nS: number, out: Float64Array): void {
  const w = g.width, h = g.height, d = g.data;
  const read: Read = (ix, iy) => d[(iy < 0 ? 0 : iy >= h ? h - 1 : iy) * w + (ix < 0 ? 0 : ix >= w ? w - 1 : ix)];
  const [ox, oy] = lonLatToPixel(lon, lat, g.z);
  out[0] = sampleGrid(g, ox, oy);
  if (nS < 2) return;
  const f1 = lat * D2R, sf = Math.sin(f1), cf = Math.cos(f1), t = azDeg * D2R, st = Math.sin(t), ct = Math.cos(t), l1 = lon * D2R;
  // Окно первого отсчёта начинается от самого пульта (как в profile): ближнее препятствие не выпадает.
  rayNode(g, sf, cf, st, ct, l1, 0);
  let ax = RX, ay = RY;
  for (let k = 1; k < nS; k++) {
    rayNode(g, sf, cf, st, ct, l1, (k + 0.5) * step);
    out[k] = segMax(read, ax, ay, RX, RY);
    ax = RX; ay = RY;
  }
}

/** Шаг пикселя DEM на широте lat, м. */
export function demPixelM(lat: number, z: number): number {
  return (2 * Math.PI * R_EARTH * Math.cos(lat * D2R)) / (256 * 2 ** z);
}

/**
 * Единый план рельефа для профиля и зоны: уровень DEM и шаг выборки.
 * z — пиксель ≈ 15 м (SRTM 30 м → 2 узла на ячейку, не мельче нужного), не выше DEM_MAX_Z;
 * если tilesAt(z) > maxTiles (зона ≤ 256 тайлов ≈ 64 МБ Float32) — z понижается.
 * step = max(пиксель, D/400): окно максимума ±step/2 одинаково у профиля и зоны на одной дистанции.
 */
export function demPlan(lat: number, D: number, tilesAt?: (z: number) => number, maxTiles = 256): { z: number; step: number } {
  let z = Math.max(8, Math.min(DEM_MAX_Z, 14, Math.round(Math.log2((40075016.7 * Math.cos(lat * D2R)) / TILE / 15))));
  if (tilesAt) while (z > 8 && tilesAt(z) > maxTiles) z--;
  return { z, step: Math.max(demPixelM(lat, z), D / 400) };
}

/** Предел мозаики зоны покрытия: 256 тайлов ≈ 64 МБ Float32. */
export const COVERAGE_MAX_TILES = 256;
/** Радиусы зоны покрытия, км (выбор в шторке зоны; под них же качаются офлайн-районы). */
export const COVERAGE_RADII_KM = [5, 10, 15, 25, 40];

/** Квадрат, описанный вокруг круга зоны: границы по сторонам света. */
export function coverageBox(c: LatLon, radius: number): { w: number; e: number; n: number; s: number } {
  return {
    w: destination(c, 270, radius).lon, e: destination(c, 90, radius).lon,
    n: destination(c, 0, radius).lat, s: destination(c, 180, radius).lat,
  };
}

/** План рельефа зоны покрытия (уровень и шаг) — общий для расчёта зоны и офлайн-районов. */
export function coverageZoom(c: LatLon, radius: number): { z: number; step: number } {
  const b = coverageBox(c, radius);
  const corners = [{ lat: b.n, lon: b.w }, { lat: b.s, lon: b.e }];
  return demPlan(c.lat, radius, (z) => demTileCount(corners, z, 2), COVERAGE_MAX_TILES);
}

/** Подсказка о грубом рельефе: SRTM покрывает 56°S–60°N, дальше Terrarium берёт другие источники. */
export function demQualityHint(...lats: number[]): string | null {
  return lats.some((l) => l > 60 || l < -56) ? 'Выше 60° рельеф грубее (~100–250 м): добавьте запас 5 дБ' : null;
}

/** Профиль рельефа между двумя точками: n+1 отметок по дуге большого круга (концы — билинейно, середина — максимум в окне). */
export async function profile(a: LatLon, b: LatLon, n: number, z: number): Promise<Float32Array> {
  // Границы окон на трассе (координаты узлов): i-й отсчёт охватывает [bx[i], bx[i+1]].
  const bx = new Float64Array(n + 1), by = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    // Крайние окна доходят до самих антенн (i = 1 → от пульта, i = n → до дрона): иначе препятствие
    // в пределах полушага от антенны выпадает из выборки (ближний хребет у низкой антенны пульта).
    const t = i <= 1 ? 0 : i >= n ? 1 : (i - 0.5) / n;
    const p = interpolate(a, b, t);
    const [x, y] = lonLatToPixel(p.lon, p.lat, z);
    bx[i] = x - 0.5; by[i] = y - 0.5;
  }
  const [sx, sy] = lonLatToPixel(a.lon, a.lat, z), [ex, ey] = lonLatToPixel(b.lon, b.lat, z);
  const scan = (read: Read, out: Float32Array) => {
    out[0] = bilin(read, sx - 0.5, sy - 0.5);
    for (let i = 1; i < n; i++) out[i] = segMax(read, bx[i], by[i], bx[i + 1], by[i + 1]);
    out[n] = bilin(read, ex - 0.5, ey - 0.5);
  };
  // Проход 1: какие тайлы нужны (качаем только вдоль линии). Проход 2: сами значения.
  const need = new Map<string, [number, number]>();
  scan((ix, iy) => {
    const tx = Math.floor(ix / TILE), ty = Math.floor(iy / TILE);
    need.set(`${tx}/${ty}`, [tx, ty]);
    return 0;
  }, new Float32Array(n + 1));
  const tiles = new Map<string, Float32Array>();
  let missing = 0;
  await Promise.all([...need].map(([k, [tx, ty]]) => getTile(z, tx, ty).then((t) => { if (t) tiles.set(k, t); else missing++; })));
  if (missing) throw new DemMissingError(missing);
  const out = new Float32Array(n + 1);
  scan((ix, iy) => {
    const tx = Math.floor(ix / TILE), ty = Math.floor(iy / TILE);
    return tiles.get(`${tx}/${ty}`)![(iy - ty * TILE) * TILE + (ix - tx * TILE)];
  }, out);
  return out;
}
