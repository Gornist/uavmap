// Подкачка рельефа вокруг пульта: как только пульт поставлен, в фоне докачиваем район радиусом зоны покрытия
// в кеш Service Worker (тот же, что у просмотренных тайлов). Сеть пульта бывает «живой» первые секунды и потом
// замирает (см. demNet.ts) — тогда зона и профиль считаются по уже скачанному. Без сети и при «экономии трафика»
// не качаем; одно место — один раз за сеанс. Основной источник не отвечает — качаем запасной (AWS).
import { S, on } from './app';
import { coverageZoom } from './elevation';
import { enumerateTiles } from './offlineCore';
import { demTileUrl } from './demTiles';
import { lonLatToPixel } from './geo';
import { cachedPrimary, loadDemTile } from './demNet';

/** Не больше стольких тайлов (зона 25 км в горах — ~64 детальных тайла, ~7 МБ). */
export const MAX_TILES = 120;
// Скромно: у AWS (HTTP/1.1) на страницу 6 соединений — подкачка не должна занимать очередь, в которой ждёт зона.
const PARALLEL = 2;
/** Пауза после установки пульта: сначала догружается сама карта. */
const DELAY_MS = 3000;

let timer = 0;
let ac: AbortController | null = null;
let doneKey = '';

/** Тайлы источника для зоны вокруг пульта, ближние к пульту — первыми. */
export function plan(lat: number, lon: number, radius: number): { z: number; x: number; y: number }[] {
  const { z } = coverageZoom({ lat, lon }, radius); // виртуальный уровень расчёта зоны
  const tiles = enumerateTiles(lat, lon, [{ z, km: radius / 1000 }]);
  if (!tiles.length) return [];
  const [px, py] = lonLatToPixel(lon, lat, tiles[0].z);
  // Тайл источника — 512 px, но сетка XYZ та же: номер тайла уровня z = пиксель lonLatToPixel(…, z) (256 px на тайл) / 256.
  // x, y тайла — его левый верхний угол, поэтому центр пульта сдвинут на полтайла.
  const cx = px / 256 - 0.5, cy = py / 256 - 0.5;
  return tiles.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2)).slice(0, MAX_TILES);
}

/**
 * Один тайл: тот же путь, что у расчётов (demNet.ts: основной, при зависании/сбое — запасной AWS). Ответы кладёт
 * в кеш Service Worker, результат не нужен. Тайлы AWS — по одному: подкачка не занимает соединения к S3, в которых ждёт зона.
 */
async function fetchTile(t: { z: number; x: number; y: number }, sig: AbortSignal): Promise<void> {
  if (await cachedPrimary(demTileUrl(t.z, t.x, t.y))) return; // уже есть (офлайн-район, прежняя подкачка)
  const r = await loadDemTile(t.z, t.x, t.y, { signal: sig, serial: true });
  if (r?.kind === 'primary') r.bitmap.close();
}

async function run(): Promise<void> {
  const st = S.station;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
  if (!st || navigator.onLine === false || conn?.saveData) return;
  const radius = S.coverage.radius;
  const key = `${st.lat.toFixed(3)},${st.lon.toFixed(3)},${radius}`;
  if (key === doneKey) return;
  const tiles = plan(st.lat, st.lon, radius);
  const mine = new AbortController();
  ac = mine;
  let i = 0;
  const worker = async () => {
    while (i < tiles.length && !mine.signal.aborted) await fetchTile(tiles[i++], mine.signal);
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (!mine.signal.aborted && ac === mine) doneKey = key;
}

/** Подкачать заново (сменился радиус зоны): прежнее место с другим радиусом — другой набор тайлов. */
export function prefetchSoon(): void { schedule(); }

function schedule(): void {
  clearTimeout(timer);
  ac?.abort();
  ac = null;
  if (S.station) timer = window.setTimeout(() => { void run(); }, DELAY_MS);
}

export function initPrefetch(): void {
  on('station', schedule);
  window.addEventListener('online', schedule);
  schedule();
}
