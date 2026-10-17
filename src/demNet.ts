// Запасной источник рельефа. Основной — Mapterhorn (за Cloudflare): на пульте без VPN соединение с ним иногда
// замирает — из 42 тайлов приходят несколько, остальные висят до таймаута (через VPN в то же время — все за 2 с).
// Тогда тайл берём с AWS Terrarium (S3, не Cloudflare): та же кодировка Terrarium, тайлы 256 px — тайл источника
// 512 px уровня z склеивается из четырёх тайлов AWS уровня z+1. Данные AWS грубее и на несколько метров
// расходятся с Copernicus — для запасного пути это лучше, чем «Нет данных рельефа».
//
// Правила выбора источника живут только здесь (loadDemTile): расчёты (elevation.ts), отмывка (demSource.ts)
// и подкачка (prefetch.ts) зовут одну функцию.
import { demTileUrl } from './demTiles';
import { fetchBlob, HttpStatusError } from './netTiles';

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
export type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
const SRC = 512, HALF = 256;
const PARTS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;

function canvas(): Canvas2D {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SRC, SRC) : Object.assign(document.createElement('canvas'), { width: SRC, height: SRC });
}

/**
 * Тайл источника (z, x, y) из AWS: четыре тайла уровня z+1, склеенные в холст 512 px. Не отклоняется: хоть одного
 * нет (или отмена) — null. serial — по одному запросу за раз (фоновая подкачка не занимает соединения к S3).
 */
async function awsStitched(z: number, x: number, y: number, signal?: AbortSignal, serial = false): Promise<Canvas2D | null> {
  try {
    const get = ([dx, dy]: readonly [number, number]) => fetchBlob(awsTileUrl(z + 1, 2 * x + dx, 2 * y + dy), signal).then((b) => createImageBitmap(b));
    let bmps: ImageBitmap[];
    if (serial) {
      bmps = [];
      for (const p of PARTS) bmps.push(await get(p));
    } else {
      bmps = await Promise.all(PARTS.map(get));
    }
    if (bmps.some((b) => b.width !== HALF || b.height !== HALF)) return null;
    const c = canvas();
    const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    PARTS.forEach(([dx, dy], i) => ctx.drawImage(bmps[i], dx * HALF, dy * HALF));
    return c;
  } catch {
    return null;
  }
}

/** Blob → ArrayBuffer; Blob.arrayBuffer() есть только с Chrome 76, а пульты — на Chrome 68. */
export const blobBuffer = (b: Blob): Promise<ArrayBuffer> => new Response(b).arrayBuffer();

/** Холст → PNG (без потерь: высоты Terrarium в цвете пикселя искажать нельзя). */
export async function canvasPng(c: Canvas2D): Promise<ArrayBuffer> {
  if ('convertToBlob' in c) return blobBuffer(await c.convertToBlob({ type: 'image/png' }));
  const blob = await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, 'image/png'));
  if (!blob) throw new Error('png');
  return blobBuffer(blob);
}

// ---------- Тайл источника: основной или запасной ----------
/**
 * Тайл источника: картинка основного (WebP как пришла и уже разобранная — проверена, 512 px) или холст 512 px,
 * склеенный из AWS. Кому разобранная картинка не нужна, закрывает её (bitmap.close()).
 */
export type DemTile = { kind: 'primary'; blob: Blob; bitmap: ImageBitmap } | { kind: 'aws'; canvas: Canvas2D };

/** Картинка основного источника, проверенная разбором: битая или не 512 px — null (за тайл не принимаем, идём в AWS). */
async function primaryTile(blob: Blob): Promise<DemTile | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width === SRC && bitmap.height === SRC) return { kind: 'primary', blob, bitmap };
    bitmap.close();
  } catch {
    // битая картинка
  }
  return null;
}

/** Первый непустой результат из двух; null — если оба пустые. Обе ветки не должны отклоняться. */
export function firstOf<T>(a: Promise<T | null>, b: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    let left = 2;
    const take = (v: T | null) => { if (v) resolve(v); else if (--left === 0) resolve(null); };
    a.then(take); b.then(take);
  });
}

/**
 * Тайл источника (координаты источника, 512 px). Не отклоняется; null — тайла нет, оба источника не отдали или отмена.
 * - Предохранитель открыт — тайл основного из кеша (офлайн-район, подкачка), нет в кеше — сразу AWS.
 * - Иначе основной: одна попытка с таймаутом PRIMARY_TIMEOUT_MS. Молчит дольше HEDGE_MS — параллельно AWS,
 *   берём первый непустой ответ: зависание основного стоит ~1,5 с, а не таймаут.
 * - 4xx основного — «тайла нет» (null, в запасной не ходим). 5xx, таймаут, обрыв — сбой для предохранителя и AWS.
 *   Отмена по signal сбоем не считается. Картинка, которая не разбирается (или не 512 px), — тоже в AWS.
 * serial — запросы AWS по одному (фоновая подкачка).
 */
export async function loadDemTile(z: number, x: number, y: number, opt: { signal?: AbortSignal; serial?: boolean } = {}): Promise<DemTile | null> {
  const { signal, serial } = opt;
  const url = demTileUrl(z, x, y);
  const aws = async (sig = signal): Promise<DemTile | null> => {
    if (sig?.aborted) return null;
    const c = await awsStitched(z, x, y, sig, serial);
    return c ? { kind: 'aws', canvas: c } : null;
  };
  if (primaryDown()) {
    const hit = await cachedPrimary(url);
    return (hit && await primaryTile(hit)) || aws();
  }
  // Ветка основного не отклоняется: иначе firstOf (только непустые ответы) мог бы ждать вечно.
  // 'gone' — тайла нет или запрос отменён: в запасной не идём.
  const primary: Promise<DemTile | 'gone' | null> = fetchBlob(url, signal, PRIMARY_TIMEOUT_MS, 1).then(
    (blob) => { reportPrimary(true); return primaryTile(blob); }, // сервер ответил; битая картинка — в запасной
    (e) => {
      if (signal?.aborted || (e instanceof HttpStatusError && e.status < 500)) return 'gone' as const;
      reportPrimary(false);
      return null;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quick = await Promise.race([primary, new Promise<undefined>((r) => { timer = setTimeout(r, HEDGE_MS); })]);
  clearTimeout(timer);
  if (quick === 'gone') return null;
  if (quick) return quick;
  if (quick === null) return aws(); // основной ответил сбоем быстро
  // Основной всё-таки ответил первым — запасной отменяем: не держать соединения к S3 (у подкачки — сверх её лимита).
  // Основной же при победе AWS дожидаемся: его исход (ответ или таймаут) нужен предохранителю.
  const awsAc = new AbortController();
  const stop = () => awsAc.abort();
  signal?.addEventListener('abort', stop);
  let winner: DemTile | null = null;
  const first = primary.then((v) => { if (!v || v === 'gone') return null; awsAc.abort(); return v; });
  const res = await firstOf(first, aws(awsAc.signal)).finally(() => signal?.removeEventListener('abort', stop));
  winner = res;
  // Победил AWS, а основной ответил позже — его разобранная картинка никому не нужна: освободить память.
  void first.then((v) => { if (v && v !== winner && v.kind === 'primary') v.bitmap.close?.(); });
  return res;
}
