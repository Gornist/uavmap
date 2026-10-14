// Один источник тайлов рельефа на всё приложение (maplibre-contour): тайл скачивается и разбирается один раз
// в воркере, а пользуются им горизонтали, отмывка MapLibre (через общий протокол) и наши расчёты (getDemTile).
// Раньше каждый из трёх качал и разбирал тот же тайл сам — втрое больше трафика и работы на старте.
import maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { DEM_URL, SHARED_DEM_MAX_Z, demTileUrl } from './demTiles';
import { fetchBuffer } from './netTiles';
import { setSharedDem } from './elevation';

/**
 * Воркер maplibre-contour возвращает ошибки на страницу через postMessage, а старые Chrome (пульты на Chrome 68)
 * не умеют передавать объект Error (DataCloneError): ответ теряется, и запрос висит вечно. Повторный запрос
 * того же тайла проходит, поэтому: 1) таймаут скачивания в воркере длинный — на старте, когда одновременно грузятся
 * спутник, подписи и рельеф (6 соединений на сервер), запросы не отваливаются с ошибкой; 2) горизонтали и отмывка
 * ходят через обёртки ниже: не дождались — отменяем и повторяем / берём тайл напрямую. Без воркера maplibre-contour
 * в Chrome 68 не работает вовсе.
 */
export const demSource = new mlcontour.DemSource({
  url: DEM_URL, encoding: 'terrarium', maxzoom: SHARED_DEM_MAX_Z, worker: true,
  cacheSize: 40, // разобранные тайлы 512 px (1 МБ каждый) в воркере: экран отмывки и горизонталей + трасса
  timeoutMs: 30000, // см. выше: ошибка из воркера на старых Chrome теряется — пусть лучше дождётся
});
demSource.setupMaplibre(maplibregl);
setSharedDem((z, x, y) => demSource.getDemTile(z, x, y));

/**
 * Тайлы для отмывки MapLibre: из общего кеша, а если он не отдал — прямым запросом со страницы.
 * Запасной путь нужен старым Chrome: там воркер из blob может не видеть Service Worker, и без сети
 * отмывка не нашла бы скачанные офлайн-районы (прямой запрос со страницы их находит, как раньше).
 */
const HILLSHADE_PROTO = 'uavdem';
export const HILLSHADE_DEM_URL = `${HILLSHADE_PROTO}://{z}/{x}/{y}`;
/** Запрос к протоколу maplibre-contour, ограниченный по времени: по истечении — отмена (снимает запрос в воркере). */
function bounded<T>(run: (ac: AbortController) => Promise<T>, outer: AbortController, ms: number): Promise<T> {
  const inner = new AbortController();
  const stop = () => inner.abort();
  outer.signal.addEventListener('abort', stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(inner),
    new Promise<never>((_, rej) => { timer = setTimeout(() => { inner.abort(); rej(new Error('timeout')); }, ms); }),
  ]).finally(() => { clearTimeout(timer); outer.signal.removeEventListener('abort', stop); });
}

/**
 * Горизонтали: тайл, не пришедший за 15 с (ответ с ошибкой потерялся в старом Chrome), запрашиваем ещё раз.
 * Ошибку наружу не отдаём никогда: векторные тайлы грузит воркер MapLibre, и ответ протокола с ошибкой
 * (Error, AbortError) старый Chrome не может ему переслать (DataCloneError) — тайл висел бы «загружается»
 * до перезагрузки, так на пульте пропадали все горизонтали. Не вышло — пустой тайл: на этом участке нет линий.
 */
const CONTOUR_PROTO = 'uavcontour';
const CONTOUR_WAIT_MS = 15000;
const EMPTY_TILE = () => ({ data: new ArrayBuffer(0) });
maplibregl.addProtocol(CONTOUR_PROTO, async (params, ac) => {
  const url = params.url.replace(`${CONTOUR_PROTO}://`, `${demSource.contourProtocolId}://`);
  for (let i = 0; i < 2 && !ac.signal.aborted; i++) {
    try {
      return await bounded((inner) => demSource.contourProtocolV4({ ...params, url }, inner), ac, CONTOUR_WAIT_MS);
    } catch {
      // повторим один раз; отменённый запрос (карту сдвинули) MapLibre уже не ждёт
    }
  }
  return EMPTY_TILE();
});
/** Адрес тайлов горизонталей (через обёртку с повтором). */
export const contourTilesUrl = (opts: Parameters<typeof demSource.contourProtocolUrl>[0]) =>
  demSource.contourProtocolUrl(opts).replace(`${demSource.contourProtocolId}://`, `${CONTOUR_PROTO}://`);

/** Сколько ждать общий источник для отмывки, прежде чем идти прямым запросом (воркер мог потерять ответ). */
const HILLSHADE_SHARED_MS = 12000;
maplibregl.addProtocol(HILLSHADE_PROTO, async (params, ac) => {
  const m = /^uavdem:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error(`Неверный адрес тайла рельефа: ${params.url}`);
  const [z, x, y] = [+m[1], +m[2], +m[3]];
  try {
    return await bounded((inner) => demSource.sharedDemProtocolV4({ ...params, url: `${demSource.sharedDemProtocolId}://${z}/${x}/${y}` }, inner), ac, HILLSHADE_SHARED_MS);
  } catch (e) {
    if (ac.signal.aborted) throw e; // тайл больше не нужен (карту сдвинули)
    return { data: await fetchBuffer(demTileUrl(z, x, y), ac.signal) }; // с таймаутом и повтором
  }
});
