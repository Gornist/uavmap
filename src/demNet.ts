// Запасной источник рельефа. Основной — Mapterhorn (за Cloudflare): на пульте без VPN соединение с ним иногда
// замирает — из 42 тайлов приходят несколько, остальные висят до таймаута (через VPN в то же время — все за 2 с).
// Тогда тайл берём с AWS Terrarium (S3, не Cloudflare): та же кодировка Terrarium, тайлы 256 px — тайл источника
// 512 px уровня z склеивается из четырёх тайлов AWS уровня z+1. Данные AWS грубее и на несколько метров
// расходятся с Copernicus — для запасного пути это лучше, чем «Нет данных рельефа».

export const AWS_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const AWS_PREFIX = AWS_URL.slice(0, AWS_URL.indexOf('{z}'));
export const awsTileUrl = (z: number, x: number, y: number) => AWS_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Ждать основной источник не дольше (штатно тайл приходит за 0,1–0,3 с); дальше — запасной. */
export const PRIMARY_TIMEOUT_MS = 6000;
/** Основной молчит дольше — параллельно запрашиваем запасной и берём первый ответ (основной всё ещё ждём до таймаута). */
export const HEDGE_MS = 1500;

// ---------- Предохранитель ----------
// Два сбоя основного источника подряд — следующие 5 минут сразу запасной: не ждать таймаутов на каждом тайле.
const FAIL_LIMIT = 2;
const OPEN_MS = 5 * 60 * 1000;
let fails = 0, openUntil = 0;

/** Основной источник сейчас считаем недоступным. */
export const primaryDown = (now = Date.now()) => now < openUntil;

/** Исход запроса к основному источнику (отменённые и «тайла нет» — не сбой, их не передают). */
export function reportPrimary(ok: boolean, now = Date.now()): void {
  if (ok) { fails = 0; openUntil = 0; return; }
  if (++fails >= FAIL_LIMIT) { fails = 0; openUntil = now + OPEN_MS; }
}

/** Для тестов: сбросить состояние предохранителя. */
export function resetPrimary(): void { fails = 0; openUntil = 0; }

/**
 * Тайл основного источника из кеша (офлайн-районы, просмотренные и подкачанные тайлы — Cache Storage, его пишет
 * Service Worker). Нужен, когда предохранитель открыт: без сети сохранённый рельеф не должен пропадать.
 */
export async function cachedPrimary(url: string): Promise<Blob | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const r = await caches.match(url);
    return r && r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

// ---------- Склейка тайла 512 px из четырёх тайлов AWS ----------
type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
const SRC = 512, HALF = 256;

function canvas(): Canvas2D {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SRC, SRC) : Object.assign(document.createElement('canvas'), { width: SRC, height: SRC });
}

/**
 * Тайл источника (z, x, y) из AWS: четыре тайла уровня z+1, склеенные в холст 512 px. null — хоть одного нет.
 * get(url) — загрузка картинки (у вызывающего свои таймауты и повторы).
 */
export async function awsStitched(z: number, x: number, y: number, get: (url: string) => Promise<Blob>): Promise<Canvas2D | null> {
  const parts = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  let bmps: ImageBitmap[];
  try {
    bmps = await Promise.all(parts.map(([dx, dy]) => get(awsTileUrl(z + 1, 2 * x + dx, 2 * y + dy)).then((b) => createImageBitmap(b))));
  } catch {
    return null;
  }
  if (bmps.some((b) => b.width !== HALF || b.height !== HALF)) return null;
  const c = canvas();
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  parts.forEach(([dx, dy], i) => ctx.drawImage(bmps[i], dx * HALF, dy * HALF));
  return c;
}

/** Холст → PNG (без потерь: высоты Terrarium в цвете пикселя искажать нельзя). */
export async function canvasPng(c: Canvas2D): Promise<ArrayBuffer> {
  if ('convertToBlob' in c) return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
  const blob = await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, 'image/png'));
  if (!blob) throw new Error('png');
  return blob.arrayBuffer();
}
