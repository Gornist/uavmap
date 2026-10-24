// Свои карты: PMTiles и MBTiles как офлайн-подложка, HGT и GeoTIFF как свой рельеф (хранение — OPFS).
import './styles/mymaps.css';
import maplibregl from 'maplibre-gl';
import { S, map, toast, openSheet, progress, addBase, removeBase, ensureBase, applyMapStyle, BASES } from './app';
import { h, button, confirmDialog } from './ui';
import { setLocalDemProvider } from './elevation';
import { HgtTile, checkHgtFile, parseHgtName, tileCoverage, synthTile, tileBounds } from './hgt';
import type { TifGrid } from './geotiff';
import { blobSource, MyMapItem, META_KEY, MAX_ITEMS, PM_MAX_BYTES, PM_HEADER_BYTES, checkPmtiles, parseMeta, serializeMeta, newId, cleanName, fmtBounds } from './mymapsCore';
import { fmtBytes } from './format';

const DIR = 'mymaps';
const PROTO = 'uavpm';
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)).buffer;

let items: MyMapItem[] = [];
/** Сколько своих карт подключено (для меню). */
export const myMapsCount = () => items.length;
/** Файлы, подключённые только на сессию (OPFS недоступен или не хватило места). */
const sessionFiles = new Map<string, File>();
/** Подключённые подложки: id → чтение тайла XYZ (PMTiles или MBTiles). */
type TileGetter = (z: number, x: number, y: number, signal: AbortSignal) => Promise<ArrayBuffer | Uint8Array | null>;
const archives = new Map<string, TileGetter>();
let protoAdded = false;

// ---------- Хранилище ----------
const loadMeta = () => { try { items = parseMeta(localStorage.getItem(META_KEY)); } catch { items = []; } };
// Сессионные карты в метаданные не пишем: после перезапуска файла уже нет.
const saveMeta = () => { try { localStorage.setItem(META_KEY, serializeMeta(items.filter((i) => !sessionFiles.has(i.id)))); } catch { toast('Не удалось сохранить список карт: мало места в браузере. Удалите ненужную карту или офлайн-район', 5000); } };

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  } catch { return null; }
}

async function fileOf(it: MyMapItem): Promise<File> {
  const s = sessionFiles.get(it.id);
  if (s) return s;
  const d = await dir();
  if (!d) throw new Error('Хранилище браузера недоступно — добавьте файл заново');
  return (await d.getFileHandle(it.file)).getFile();
}

/** Копирование файла в OPFS стримом. false — OPFS недоступен/места нет (тогда подключаем на сессию). */
async function copyToOpfs(f: File, name: string): Promise<boolean> {
  const d = await dir();
  if (!d || typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) return false;
  try {
    const est = await navigator.storage.estimate();
    if (est.quota !== undefined && est.usage !== undefined && est.quota - est.usage < f.size * 1.05) return false;
  } catch { /* оценка недоступна — пробуем */ }
  navigator.storage.persist?.().catch(() => undefined);
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  try {
    const rd = f.stream().getReader();
    let done = 0;
    for (;;) {
      const { value, done: end } = await rd.read();
      if (end) break;
      await w.write(value);
      done += value.byteLength;
      progress(done / f.size, `Копирование: ${fmtBytes(done)} из ${fmtBytes(f.size)}`);
    }
    await w.close();
    return true;
  } catch (e) {
    await w.abort().catch(() => undefined);
    await d.removeEntry(name).catch(() => undefined);
    if (e instanceof DOMException && e.name === 'QuotaExceededError') return false;
    throw e;
  }
}

async function removeFromOpfs(name: string) {
  const d = await dir();
  await d?.removeEntry(name).catch(() => undefined);
}

// ---------- PMTiles и MBTiles как подложка ----------
function ensureProtocol() {
  if (protoAdded) return;
  protoAdded = true;
  maplibregl.addProtocol(PROTO, async (p, ac) => {
    const m = /^uavpm:\/\/([a-z0-9]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(p.url);
    const get = m && archives.get(m[1]);
    if (!get) throw new Error('Карта не подключена');
    const r = await get(+m[2], +m[3], +m[4], ac.signal);
    return { data: r ? (r instanceof Uint8Array ? r.slice().buffer : r) : EMPTY_PNG };
  });
}

async function activatePmtiles(it: MyMapItem) {
  ensureProtocol();
  if (it.kind === 'mbtiles') {
    // Чтение SQLite — свой модуль (mbtiles.ts), отдельным чанком.
    const { MbTiles } = await import('./mbtiles');
    const db = await MbTiles.open(blobSource(await fileOf(it)));
    archives.set(it.id, (z, x, y) => db.getZxy(z, x, y));
  } else {
    // Библиотека PMTiles (~45 КБ) — отдельным чанком: нужна только тем, у кого есть свои карты.
    const { PMTiles, FileSource } = await import('pmtiles');
    const pm = new PMTiles(new FileSource(await fileOf(it)));
    archives.set(it.id, async (z, x, y, signal) => (await pm.getZxy(z, x, y, signal))?.data ?? null);
  }
  addBase(`my-${it.id}`, { name: `★ ${it.name}`, tiles: [`${PROTO}://${it.id}/{z}/{x}/{y}`], max: it.maxzoom ?? 18, attr: `Свои карты: ${it.name}` }, { minzoom: it.minzoom ?? 0, bounds: it.bounds });
}

function deactivatePmtiles(it: MyMapItem) {
  removeBase(`my-${it.id}`);
  archives.delete(it.id);
}

// ---------- HGT как рельеф ----------
const hgtCache = new Map<string, Promise<HgtTile>>(); // id → ячейка (LRU по порядку вставки)
const HGT_LRU = 2; // ячейка SRTM1 — 26 МБ Int16

function loadHgt(it: MyMapItem): Promise<HgtTile> {
  let p = hgtCache.get(it.id);
  if (p) { hgtCache.delete(it.id); hgtCache.set(it.id, p); return p; }
  p = fileOf(it).then((f) => f.arrayBuffer()).then((b) => HgtTile.fromBuffer(`${hgtName(it)}`, b));
  p.catch(() => hgtCache.delete(it.id));
  hgtCache.set(it.id, p);
  while (hgtCache.size > HGT_LRU) hgtCache.delete(hgtCache.keys().next().value!);
  return p;
}

/** Имя ячейки (N55E037.hgt) из границ: так не храним лишнего и не доверяем имени из метаданных. */
function hgtName(it: MyMapItem): string {
  const la = Math.round(it.bounds[1]), lo = Math.round(it.bounds[0]);
  return `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}.hgt`;
}

const hgtItems = () => items.filter((i) => i.kind === 'hgt');
const tifItems = () => items.filter((i) => i.kind === 'tif');
const cellKey = (la: number, lo: number) => `${la},${lo}`;

// ---------- GeoTIFF как рельеф ----------
const tifCache = new Map<string, Promise<TifGrid>>(); // id → растр (LRU по порядку вставки)
const TIF_LRU = 1; // растр — до 32 МБ Int16 (geotiff.ts, MAX_PX)

function loadTif(it: MyMapItem): Promise<TifGrid> {
  let p = tifCache.get(it.id);
  if (p) { tifCache.delete(it.id); tifCache.set(it.id, p); return p; }
  p = Promise.all([fileOf(it), import('./geotiff')]).then(([f, m]) => m.readGeoTiff(blobSource(f)));
  p.catch(() => tifCache.delete(it.id));
  tifCache.set(it.id, p);
  while (tifCache.size > TIF_LRU) tifCache.delete(tifCache.keys().next().value!);
  return p;
}

/** Границы тайла XYZ пересекаются с прямоугольником [з, ю, в, с]. */
const touches = (z: number, x: number, y: number, b: [number, number, number, number]) => {
  const t = tileBounds(z, x, y);
  return t.west < b[2] && t.east > b[0] && t.south < b[3] && t.north > b[1];
};

/** Свой рельеф для тайла: сначала ячейки HGT (если покрывают целиком), потом растры GeoTIFF; null — из сети. */
function refreshDem() {
  const hs = hgtItems(), ts = tifItems();
  if (!hs.length && !ts.length) { setLocalDemProvider(null); return; }
  const byCell = new Map(hs.map((i) => [cellKey(Math.round(i.bounds[1]), Math.round(i.bounds[0])), i]));
  setLocalDemProvider(async (z, x, y) => {
    const cells = byCell.size ? tileCoverage(z, x, y, (la, lo) => byCell.has(cellKey(la, lo))) : null;
    if (cells) {
      const tiles = new Map<string, HgtTile>();
      for (const [la, lo] of cells) tiles.set(cellKey(la, lo), await loadHgt(byCell.get(cellKey(la, lo))!));
      return synthTile(z, x, y, (la, lo) => tiles.get(cellKey(la, lo)));
    }
    for (const it of ts) {
      if (!touches(z, x, y, it.bounds)) continue;
      const [g, m] = await Promise.all([loadTif(it), import('./geotiff')]);
      const t = m.synthFromGrid(z, x, y, g);
      if (t) return t;
    }
    return null;
  });
}

// ---------- Восстановление ----------
export async function initMyMaps(): Promise<void> {
  loadMeta();
  // Провайдер высот ставим синхронно, до первого await: main.ts сразу после initMyMaps() считает высоту под прицелом,
  // и без этого она уходила в сеть (офлайн — «—»). Файлы провайдер читает лениво; недоступный файл → null → сеть.
  refreshDem();
  const bad: MyMapItem[] = [];
  // Сбой загрузки чанка PMTiles (нет сети, сменилась сборка) — не повод забыть карты: файлы на месте, запись оставляем.
  let pmOk = true;
  if (items.some((i) => i.kind === 'pmtiles')) {
    try { await import('pmtiles'); } catch (e) {
      pmOk = false;
      console.warn('mymaps: модуль PMTiles не загрузился', e);
      toast('Свои карты-подложки не подключились — обновите страницу', 6000);
    }
  }
  // То же для MBTiles: модуль чтения не загрузился — записи и файлы оставляем, подключим после обновления страницы.
  let mbOk = true;
  if (items.some((i) => i.kind === 'mbtiles')) {
    try { await import('./mbtiles'); } catch (e) {
      mbOk = false;
      console.warn('mymaps: модуль MBTiles не загрузился', e);
      toast('Свои карты-подложки не подключились — обновите страницу', 6000);
    }
  }
  for (const it of items) {
    if ((it.kind === 'pmtiles' && !pmOk) || (it.kind === 'mbtiles' && !mbOk)) continue;
    try {
      if (it.kind === 'pmtiles' || it.kind === 'mbtiles') await activatePmtiles(it);
      else await fileOf(it); // HGT: проверяем, что файл на месте
    } catch (e) {
      console.warn('mymaps: не удалось восстановить', it.id, e);
      bad.push(it);
    }
  }
  if (bad.length) {
    items = items.filter((i) => !bad.includes(i));
    saveMeta();
    toast(`Свои карты: не найдено файлов — ${bad.length} (браузер очистил хранилище). Добавьте их заново: Меню → Офлайн → Свои карты`, 6000);
  }
  refreshDem();
  ensureBase();
}

// ---------- Импорт ----------
// В accept есть octet-stream: пикер Android фильтрует по MIME и иначе затемняет «неизвестные» .pmtiles/.hgt.
// Содержимое всё равно проверяется после выбора (сигнатура, размер).
function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.addEventListener('change', () => res([...(i.files ?? [])]));
    i.addEventListener('cancel', () => res([]));
    i.click();
  });
}

const where = (inOpfs: boolean) => (inOpfs ? '' : ' — только до перезапуска: в браузере мало места или нет хранилища');

async function importPmtiles(f: File) {
  if (items.length >= MAX_ITEMS) throw new Error(`Не больше ${MAX_ITEMS} карт — удалите ненужную`);
  if (f.size > PM_MAX_BYTES) throw new Error('Файл больше 2 ГБ — вырежьте нужный район (pmtiles extract)');
  const head = await f.slice(0, PM_HEADER_BYTES).arrayBuffer();
  const v = checkPmtiles(head, f.size, (await import('pmtiles')).bytesToHeader);
  if (!v.ok) throw new Error(v.error);
  const id = newId();
  const it: MyMapItem = { id, kind: 'pmtiles', name: cleanName(f.name.replace(/\.pmtiles$/i, '')) || id, size: f.size, added: Date.now(), file: `${id}.pmtiles`, bounds: v.info.bounds, minzoom: v.info.minzoom, maxzoom: v.info.maxzoom };
  const stored = await copyToOpfs(f, it.file);
  if (!stored) sessionFiles.set(id, f);
  items.push(it);
  try { await activatePmtiles(it); } catch (e) { items.pop(); sessionFiles.delete(id); await removeFromOpfs(it.file); throw e; }
  saveMeta();
  toast(`Карта «${it.name}» подключена${where(stored)}`, 4500);
}

async function importMbtiles(f: File) {
  if (items.length >= MAX_ITEMS) throw new Error(`Не больше ${MAX_ITEMS} карт — удалите ненужную`);
  if (f.size > PM_MAX_BYTES) throw new Error('Файл больше 2 ГБ — вырежьте нужный район');
  const { MbTiles } = await import('./mbtiles');
  const db = await MbTiles.open(blobSource(f)); // проверка схемы и индексов до копирования
  const id = newId();
  const nm = cleanName(db.info.name) || cleanName(f.name.replace(/\.mbtiles$/i, '')) || id;
  const it: MyMapItem = { id, kind: 'mbtiles', name: nm, size: f.size, added: Date.now(), file: `${id}.mbtiles`, bounds: db.info.bounds, minzoom: db.info.minzoom, maxzoom: db.info.maxzoom };
  const stored = await copyToOpfs(f, it.file);
  if (!stored) sessionFiles.set(id, f);
  items.push(it);
  try { await activatePmtiles(it); } catch (e) { items.pop(); sessionFiles.delete(id); await removeFromOpfs(it.file); throw e; }
  saveMeta();
  toast(`Карта «${it.name}» подключена${where(stored)}`, 4500);
}

async function importTif(f: File) {
  if (items.length >= MAX_ITEMS) throw new Error(`Не больше ${MAX_ITEMS} карт — удалите ненужную`);
  const { readGeoTiff, TIF_MAX_BYTES } = await import('./geotiff');
  if (f.size > TIF_MAX_BYTES) throw new Error('Файл больше 1 ГБ — вырежьте нужный район (gdal_translate -projwin)');
  progress(0.1, 'Читаю GeoTIFF…');
  const g = await readGeoTiff(blobSource(f)); // полная проверка: привязка, система координат, высоты
  const id = newId();
  const it: MyMapItem = { id, kind: 'tif', name: cleanName(f.name.replace(/\.tiff?$/i, '')) || id, size: f.size, added: Date.now(), file: `${id}.tif`, bounds: g.bounds };
  const stored = await copyToOpfs(f, it.file);
  if (!stored) sessionFiles.set(id, f);
  items.push(it);
  tifCache.set(id, Promise.resolve(g));
  while (tifCache.size > TIF_LRU) tifCache.delete(tifCache.keys().next().value!);
  saveMeta();
  refreshDem();
  const step = g.stepM >= 10 ? `${Math.round(g.stepM)} м` : `${g.stepM.toFixed(1).replace('.', ',')} м`;
  toast(`Рельеф «${it.name}» подключён: ${g.crs}, шаг ${step}${g.reduced ? ' (уменьшенная копия)' : ''}${where(stored)}`, 6000);
}

/** Свой рельеф: по расширению — GeoTIFF или ячейка HGT. */
const importDem = (f: File) => (/\.tiff?$/i.test(f.name) ? importTif(f) : importHgt(f));

/** Карта-подложка: по расширению — PMTiles или MBTiles. */
const importMap = (f: File) => (/\.mbtiles$/i.test(f.name) ? importMbtiles(f) : importPmtiles(f));

async function importHgt(f: File) {
  const err = checkHgtFile(f.name, f.size);
  if (err) throw new Error(`${cleanName(f.name)}: ${err}`);
  const sw = parseHgtName(f.name)!;
  HgtTile.fromBuffer(f.name, await f.arrayBuffer()); // полная проверка содержимого (пропуски заполняются при каждом чтении)
  const same = hgtItems().find((i) => Math.round(i.bounds[1]) === sw.lat && Math.round(i.bounds[0]) === sw.lon);
  if (!same && items.length >= MAX_ITEMS) throw new Error(`Не больше ${MAX_ITEMS} карт — удалите ненужную`);
  const id = newId();
  const it: MyMapItem = { id, kind: 'hgt', name: hgtName({ bounds: [sw.lon, sw.lat, sw.lon + 1, sw.lat + 1] } as MyMapItem), size: f.size, added: Date.now(), file: `${id}.hgt`, bounds: [sw.lon, sw.lat, sw.lon + 1, sw.lat + 1] };
  // Сначала сохраняем новую ячейку и только потом удаляем старую: при сбое записи прежний рельеф не теряется.
  const stored = await copyToOpfs(f, it.file);
  if (!stored) sessionFiles.set(id, f);
  if (same) await dropItem(same, false);
  items.push(it);
  saveMeta();
  refreshDem();
  toast(`Рельеф ${it.name} подключён${where(stored)}`, 4500);
}

async function dropItem(it: MyMapItem, doRefresh = true) {
  if (it.kind === 'pmtiles' || it.kind === 'mbtiles') deactivatePmtiles(it);
  hgtCache.delete(it.id);
  tifCache.delete(it.id);
  sessionFiles.delete(it.id);
  items = items.filter((i) => i !== it);
  await removeFromOpfs(it.file);
  saveMeta();
  if ((it.kind === 'hgt' || it.kind === 'tif') && doRefresh) refreshDem();
}

// ---------- Шторка ----------
export function openMyMapsSheet(): void {
  const root = h('<div class="mm"></div>');
  openSheet('Свои карты', root);
  const busy = { v: false };

  const run = async (fn: () => Promise<void>) => {
    if (busy.v) return;
    busy.v = true;
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось добавить файл. Подходят растровые PMTiles и MBTiles, рельеф HGT и GeoTIFF', 6000); } finally { progress(null); busy.v = false; render(); }
  };

  function render() {
    root.innerHTML = '';
    root.appendChild(h('<p class="hint mm-hint">Своя подложка и свой рельеф из файлов — работают без сети и хранятся на этом устройстве.</p>'));
    const add = h('<div class="row"></div>');
    add.append(
      button('+ Карта (PMTiles, MBTiles)', 'primary', () => void run(async () => { for (const f of await pick('.pmtiles,.mbtiles,application/octet-stream,application/vnd.pmtiles,application/vnd.sqlite3,application/x-sqlite3', false)) await importMap(f); })),
      button('+ Рельеф (HGT, GeoTIFF)', 'ghost', () => void run(async () => { for (const f of await pick('.hgt,.tif,.tiff,image/tiff,application/octet-stream', true)) await importDem(f); })),
    );
    root.appendChild(add);
    const info = h('<details class="details"><summary>Какие файлы подходят</summary></details>');
    info.appendChild(h('<p class="hint mm-hint"></p>')).textContent = 'Карта: файл PMTiles или MBTiles с картинками (png, jpg, webp) до 2 ГБ — растровые карты из SAS.Планета, QGIS, MOBAC, TileMill. Рельеф: файлы HGT с именем вида N55E037.hgt (SRTM; например, viewfinderpanoramas.org), до 30 МБ каждый, или GeoTIFF высот до 1 ГБ (одна полоса; WGS-84, Web Mercator, UTM или СК-42 Гаусса–Крюгера; большой растр — берётся его уменьшенная копия, если она есть).';
    info.appendChild(h('<p class="hint mm-hint"></p>')).textContent = 'Свой рельеф идёт в профиль, зону и высоту под прицелом, если файлы целиком покрывают участок. Отмывка и горизонтали берутся из сети.';
    root.appendChild(info);
    if (!navigator.storage?.getDirectory) root.appendChild(h('<p class="hint mm-warn"></p>')).textContent = 'Этот браузер не умеет хранить файлы: карты подключаются до перезапуска, потом их нужно добавить снова. Обновите Chrome, чтобы они сохранялись.';

    if (!items.length) { root.appendChild(h('<p class="hint">Пока ничего не добавлено.</p>')); return; }
    const list = h('<div class="mm-list"></div>');
    for (const it of items) {
      const card = h('<div class="mm-item"></div>');
      const title = h('<div class="mm-title"></div>');
      title.textContent = it.name;
      const meta = h('<div class="mm-meta"></div>');
      const sess = sessionFiles.has(it.id) ? ' · до перезапуска' : '';
      meta.textContent = it.kind === 'pmtiles' || it.kind === 'mbtiles'
        ? `Подложка ${it.kind === 'mbtiles' ? 'MBTiles' : 'PMTiles'} · ${fmtBytes(it.size)} · масштабы ${it.minzoom}–${it.maxzoom}${sess}`
        : `Рельеф ${it.kind === 'tif' ? 'GeoTIFF' : 'HGT'} · ${fmtBytes(it.size)} · ${fmtBounds(it.bounds)}${sess}`;
      const acts = h('<div class="mm-acts"></div>');
      acts.appendChild(button('Показать', 'ghost', () => {
        const [w, s, e, n] = it.bounds;
        map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: it.maxzoom ?? 16, duration: 600 });
      }));
      if (it.kind === 'pmtiles' || it.kind === 'mbtiles') {
        const bid = `my-${it.id}`;
        const cur = S.map.base === bid;
        const b = button(cur ? 'Подложка ✓' : 'Сделать подложкой', cur ? 'ghost on' : 'ghost', () => {
          if (!BASES[bid]) { toast('Карта не подключилась — удалите её и добавьте файл заново', 5000); return; }
          S.map.base = bid; applyMapStyle(); render();
        });
        acts.appendChild(b);
      }
      acts.appendChild(button('Удалить', 'danger', () => void run(async () => {
        if (!(await confirmDialog('Удалить карту?', `«${it.name}» удалится с устройства.`, 'Удалить'))) return;
        await dropItem(it);
      })));
      card.append(title, meta, acts);
      list.appendChild(card);
    }
    root.appendChild(list);
  }
  render();
}
