// Свои карты: PMTiles как офлайн-подложка, HGT как свой рельеф (хранение — OPFS).
import './styles/mymaps.css';
import maplibregl from 'maplibre-gl';
import type { PMTiles } from 'pmtiles';
import { S, map, toast, openSheet, progress, addBase, removeBase, ensureBase, applyMapStyle, BASES } from './app';
import { h, button, confirmDialog } from './ui';
import { setLocalDemProvider } from './elevation';
import { HgtTile, checkHgtFile, parseHgtName, tileCoverage, synthTile } from './hgt';
import { MyMapItem, META_KEY, MAX_ITEMS, PM_MAX_BYTES, PM_HEADER_BYTES, checkPmtiles, parseMeta, serializeMeta, newId, cleanName, fmtBounds } from './mymapsCore';
import { fmtBytes } from './format';

const DIR = 'mymaps';
const PROTO = 'uavpm';
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)).buffer;

let items: MyMapItem[] = [];
/** Сколько своих карт подключено (для меню). */
export const myMapsCount = () => items.length;
/** Файлы, подключённые только на сессию (OPFS недоступен или не хватило места). */
const sessionFiles = new Map<string, File>();
const archives = new Map<string, PMTiles>();
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

// ---------- PMTiles как подложка ----------
function ensureProtocol() {
  if (protoAdded) return;
  protoAdded = true;
  maplibregl.addProtocol(PROTO, async (p, ac) => {
    const m = /^uavpm:\/\/([a-z0-9]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(p.url);
    const pm = m && archives.get(m[1]);
    if (!pm) throw new Error('Карта не подключена');
    const r = await pm.getZxy(+m[2], +m[3], +m[4], ac.signal);
    return { data: r ? r.data : EMPTY_PNG };
  });
}

async function activatePmtiles(it: MyMapItem) {
  ensureProtocol();
  // Библиотека PMTiles (~45 КБ) — отдельным чанком: нужна только тем, у кого есть свои карты.
  const { PMTiles, FileSource } = await import('pmtiles');
  archives.set(it.id, new PMTiles(new FileSource(await fileOf(it))));
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
const cellKey = (la: number, lo: number) => `${la},${lo}`;

function refreshDem() {
  const hs = hgtItems();
  if (!hs.length) { setLocalDemProvider(null); return; }
  const byCell = new Map(hs.map((i) => [cellKey(Math.round(i.bounds[1]), Math.round(i.bounds[0])), i]));
  setLocalDemProvider(async (z, x, y) => {
    const cells = tileCoverage(z, x, y, (la, lo) => byCell.has(cellKey(la, lo)));
    if (!cells) return null;
    const tiles = new Map<string, HgtTile>();
    for (const [la, lo] of cells) tiles.set(cellKey(la, lo), await loadHgt(byCell.get(cellKey(la, lo))!));
    return synthTile(z, x, y, (la, lo) => tiles.get(cellKey(la, lo)));
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
  for (const it of items) {
    if (it.kind === 'pmtiles' && !pmOk) continue;
    try {
      if (it.kind === 'pmtiles') await activatePmtiles(it);
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
  if (it.kind === 'pmtiles') deactivatePmtiles(it);
  hgtCache.delete(it.id);
  sessionFiles.delete(it.id);
  items = items.filter((i) => i !== it);
  await removeFromOpfs(it.file);
  saveMeta();
  if (it.kind === 'hgt' && doRefresh) refreshDem();
}

// ---------- Шторка ----------
export function openMyMapsSheet(): void {
  const root = h('<div class="mm"></div>');
  openSheet('Свои карты', root);
  const busy = { v: false };

  const run = async (fn: () => Promise<void>) => {
    if (busy.v) return;
    busy.v = true;
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось добавить файл. Подходят растровые PMTiles и ячейки HGT', 6000); } finally { progress(null); busy.v = false; render(); }
  };

  function render() {
    root.innerHTML = '';
    root.appendChild(h('<p class="hint mm-hint">Своя подложка и свой рельеф из файлов — работают без сети и хранятся на этом устройстве.</p>'));
    const add = h('<div class="row"></div>');
    add.append(
      button('+ Карта (PMTiles)', 'primary', () => void run(async () => { for (const f of await pick('.pmtiles,application/octet-stream,application/vnd.pmtiles', false)) await importPmtiles(f); })),
      button('+ Рельеф (HGT)', 'ghost', () => void run(async () => { for (const f of await pick('.hgt,application/octet-stream', true)) await importHgt(f); })),
    );
    root.appendChild(add);
    const info = h('<details class="details"><summary>Какие файлы подходят</summary></details>');
    info.appendChild(h('<p class="hint mm-hint"></p>')).textContent = 'Карта: файл PMTiles с картинками (png, jpg, webp) до 2 ГБ; из MBTiles его делает утилита pmtiles convert (github.com/protomaps/go-pmtiles). Рельеф: файлы HGT с именем вида N55E037.hgt (SRTM; например, viewfinderpanoramas.org), до 30 МБ каждый.';
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
      meta.textContent = it.kind === 'pmtiles'
        ? `Подложка · ${fmtBytes(it.size)} · масштабы ${it.minzoom}–${it.maxzoom}${sess}`
        : `Рельеф · ${fmtBytes(it.size)} · ${fmtBounds(it.bounds)}${sess}`;
      const acts = h('<div class="mm-acts"></div>');
      acts.appendChild(button('Показать', 'ghost', () => {
        const [w, s, e, n] = it.bounds;
        map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: it.maxzoom ?? 16, duration: 600 });
      }));
      if (it.kind === 'pmtiles') {
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
