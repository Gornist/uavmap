// Надёжная загрузка растровых тайлов (спутник, топо, схема, подписи, запасной путь отмывки).
// Сеть пульта иногда «встаёт» посреди запроса, а у загрузчика MapLibre таймаута нет: тайл висел «загружается»
// минутами и держал одно из 6 соединений к серверу (HTTP/1.1 у Esri и S3). Здесь — таймаут и один повтор;
// не вышло — обычная ошибка (растровые тайлы грузит страница, ошибка не пересылается в воркер).
export const NET_PROTO = 'uavnet';
const PROTO = NET_PROTO;
const TIMEOUT_MS = 10000;
const TRIES = 2;

/** Ответ сервера с ошибкой: повтор не поможет. */
class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** https://… → uavnet://…: тайл пойдёт через загрузчик с таймаутом. */
export const reliable = (url: string) => url.replace(/^https:\/\//, `${PROTO}://`);

/** Тело ответа целиком; на попытку — таймаут, зависшая или оборванная попытка повторяется, HTTP-ошибка — нет. */
export async function fetchBuffer(url: string, outer?: AbortSignal): Promise<ArrayBuffer> {
  let last: unknown = new Error('нет попыток');
  for (let i = 0; i < TRIES && !outer?.aborted; i++) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    outer?.addEventListener('abort', stop);
    const timer = setTimeout(stop, TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new HttpStatusError(r.status);
      return await r.arrayBuffer();
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

/** Обработчик протокола для maplibregl.addProtocol (регистрирует app.ts). */
export const netProtocol = async (params: { url: string }, ac: AbortController) =>
  ({ data: await fetchBuffer(params.url.replace(`${PROTO}://`, 'https://'), ac.signal) });
