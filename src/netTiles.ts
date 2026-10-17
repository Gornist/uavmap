// Надёжная загрузка тайлов: растровые (спутник, топо, схема, запасные подписи), рельеф (demNet.ts), векторные подписи, глифы.
// Сеть пульта иногда «встаёт» посреди запроса, а у загрузчика MapLibre таймаута нет: тайл висел «загружается»
// минутами и держал одно из 6 соединений к серверу (HTTP/1.1 у Esri и S3). Здесь — таймаут и один повтор;
// не вышло — обычная ошибка (растровые тайлы грузит страница, ошибка не пересылается в воркер).
export const NET_PROTO = 'uavnet';
const PROTO = NET_PROTO;
const TIMEOUT_MS = 10000;
const TRIES = 2;

/** Ответ сервера с ошибкой: повтор не поможет. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** https://… → uavnet://…: тайл пойдёт через загрузчик с таймаутом. */
export const reliable = (url: string) => url.replace(/^https:\/\//, `${PROTO}://`);

/**
 * Тело ответа целиком (read — как его прочитать); на попытку — таймаут, зависшая или оборванная попытка
 * повторяется, HTTP-ошибка — нет. Попытка завершается по таймауту или отмене, даже если fetch на сигнал не отреагировал.
 */
async function fetchBody<T>(url: string, read: (r: Response) => Promise<T>, outer: AbortSignal | undefined, timeoutMs: number, tries: number): Promise<T> {
  let last: unknown = new Error('нет попыток');
  for (let i = 0; i < tries && !outer?.aborted; i++) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    outer?.addEventListener('abort', stop);
    const timer = setTimeout(stop, timeoutMs);
    const cut = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () =>
      rej(Object.assign(new Error(outer?.aborted ? 'отменено' : 'таймаут'), { name: 'AbortError' }))));
    try {
      return await Promise.race([
        fetch(url, { signal: ac.signal }).then((r) => { if (!r.ok) throw new HttpStatusError(r.status); return read(r); }),
        cut,
      ]);
    } catch (e) {
      last = e;
      if (e instanceof HttpStatusError) throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', stop);
    }
  }
  throw last;
}

/** Тело ответа как ArrayBuffer (см. fetchBody). */
export const fetchBuffer = (url: string, outer?: AbortSignal, timeoutMs = TIMEOUT_MS, tries = TRIES) =>
  fetchBody(url, (r) => r.arrayBuffer(), outer, timeoutMs, tries);

/** Тело ответа как Blob (картинка для createImageBitmap; см. fetchBody). */
export const fetchBlob = (url: string, outer?: AbortSignal, timeoutMs = TIMEOUT_MS, tries = TRIES) =>
  fetchBody(url, (r) => r.blob(), outer, timeoutMs, tries);

/** Обработчик протокола для maplibregl.addProtocol (регистрирует app.ts). */
export const netProtocol = async (params: { url: string }, ac: AbortController) =>
  ({ data: await fetchBuffer(params.url.replace(`${PROTO}://`, 'https://'), ac.signal) });

// ---------- Векторные тайлы подписей (labels.ts) ----------
// Тайлы запрашивает воркер MapLibre через страницу. Ошибку в ответ не отдаём: в Chrome < 77 объект Error нельзя
// переслать воркеру (DataCloneError) — тайл висел бы «загружается» вечно. Не пришёл — пустой тайл, а о сбое
// узнаёт labels.ts (переход на растровые подписи). Штатно тайл приходит за 0,1–0,3 с: таймаут 6 с без повтора.
export const VEC_PROTO = 'uavvec';
const VEC_TIMEOUT_MS = 6000;

/** Исход загрузки: ok — тайл пришёл; иначе сеть не отдала (таймаут, обрыв, 5xx); fatal — не пришёл TileJSON (тайлов не будет). */
let vecHealth: (ok: boolean, fatal?: boolean) => void = () => undefined;
export const setVecHealth = (f: (ok: boolean, fatal?: boolean) => void) => { vecHealth = f; };

export const vecProtocol = async (params: { url: string; type?: string }, ac: AbortController) => {
  const url = params.url.replace(`${VEC_PROTO}://`, 'https://');
  if (params.type === 'json') {
    // TileJSON грузит страница (ошибку пересылать некуда). Ссылки на тайлы — через этот же протокол.
    try {
      const j = JSON.parse(new TextDecoder().decode(await fetchBuffer(url, ac.signal, VEC_TIMEOUT_MS))) as { tiles?: unknown };
      if (!Array.isArray(j.tiles) || !j.tiles.every((t) => typeof t === 'string' && t.startsWith('https://'))) throw new Error('TileJSON без tiles');
      return { data: { ...j, tiles: (j.tiles as string[]).map((t) => t.replace(/^https:\/\//, `${VEC_PROTO}://`)) } };
    } catch (e) {
      if (!ac.signal.aborted) vecHealth(false, true);
      throw e;
    }
  }
  try {
    const data = await fetchBuffer(url, ac.signal, VEC_TIMEOUT_MS, 1);
    vecHealth(true);
    return { data };
  } catch (e) {
    // Отменённый (карту сдвинули) и отсутствующий (4xx) тайл — не сбой сети.
    const net = !ac.signal.aborted && !(e instanceof HttpStatusError && e.status < 500);
    if (net) vecHealth(false);
    return { data: new ArrayBuffer(0) };
  }
};

// ---------- Глифы ----------
// Свои глифы (public/fonts) есть не для всех диапазонов символов. Отсутствующий диапазон — пустой ответ,
// а не ошибка: иначе тайл с такой подписью падал целиком (а в старом Chrome — висел, см. выше).
export const GLYPH_PROTO = 'uavglyph';
export const glyphProtocol = async (params: { url: string }, ac: AbortController) => {
  try {
    const r = await fetch(params.url.replace(`${GLYPH_PROTO}://`, `${location.protocol}//`), { signal: ac.signal });
    return { data: r.ok ? await r.arrayBuffer() : new ArrayBuffer(0) };
  } catch {
    return { data: new ArrayBuffer(0) };
  }
};
