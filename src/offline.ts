// Офлайн-районы: скачивание тайлов рельефа для района в Cache Storage (в интерфейсе — «рельеф района», без слова «тайлы»).
// Кеш 'uavmap-dem-v1': ключ — полный URL тайла, значение — ответ fetch(url, { mode: 'cors' }).
// Service Worker (sw.ts) отдаёт тайлы DEM оттуда в первую очередь.
//
// «Подготовить без сети» (prepareOffline; кнопки — в шторке пульта и здесь) — тот же механизм районов: район вокруг
// пульта радиусом зоны с данными для расчёта и для карты. Районы привязаны к основному источнику (Mapterhorn,
// DEM_SRC_ID): без сети их тайлы отдаёт Service Worker по адресу Mapterhorn, тайлы запасного AWS в район не пишем.
import './styles/offline.css';
import { S, map, center, openSheet, progress, toast, fc, setGeo, emit } from './app';
import { h, button, chips, confirmDialog } from './ui';
import { fmtBytes, escapeHtml } from './format';
import { destination, distance, LatLon } from './geo';
import { DEM_SRC_ID } from './demTiles';
import { primaryDown } from './demNet';
import { OFFLINE_CACHE, OFFLINE_KEY, RADII_KM, DEFAULT_TILE_BYTES, Area, Tile, tileUrl, enumerateTiles, estimateBytes, planLayers, parseAreas, exclusiveKeys, keyToUrl, areasCover, dedupLayers, prepLayers, prepRadiusKm, prepState, downloadVerdict, DownloadSummary } from './offlineCore';

// ---------- Хранилище метаданных ----------
function loadAreas(): Area[] {
  try { return parseAreas(localStorage.getItem(OFFLINE_KEY)); } catch { return []; }
}
function saveAreas(a: Area[]) {
  try { localStorage.setItem(OFFLINE_KEY, JSON.stringify({ v: 1, areas: a })); } catch { /* переполнение/запрет — не критично */ }
}

/** Сколько районов скачано (для меню). */
export const offlineAreaCount = () => loadAreas().length;

// Разбор списка районов — по изменению строки в localStorage (строка связи спрашивает на каждый пересчёт).
let coverRaw: string | null | undefined, coverAreas: Area[] = [];
/** Есть ли рельеф без сети для трассы: 'yes' / 'no' / 'none' (районов нет) — см. areasCover. */
export function offlineCover(points: LatLon[]): 'yes' | 'no' | 'none' {
  let raw: string | null = null;
  try { raw = localStorage.getItem(OFFLINE_KEY); } catch { /* нет доступа — как без районов */ }
  if (raw !== coverRaw) { coverRaw = raw; try { coverAreas = parseAreas(raw); } catch { coverAreas = []; } }
  return areasCover(coverAreas, points);
}

// ---------- Скачивание ----------
const sleep = (ms: number, sig?: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  sig?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

interface Result extends DownloadSummary { bytes: number }

/** Столько тайлов подряд не загрузилось, а ни один не скачан — источник не отвечает: не ждать таймаутов на остальных. */
const SOURCE_DOWN_AFTER = 6;

/** Попытка скачать тайл не дольше (у Service Worker свой таймаут 15 с; без него зависший запрос держал бы скачивание вечно). */
const TILE_TIMEOUT_MS = 20000;

async function fetchTile(url: string, cache: Cache, sig: AbortSignal, reload: boolean): Promise<number | 'err'> {
  for (let att = 0; att < 3; att++) {
    if (sig.aborted) return 'err';
    const ac = new AbortController();
    const stop = () => ac.abort();
    sig.addEventListener('abort', stop);
    const timer = setTimeout(stop, TILE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { mode: 'cors', signal: ac.signal, cache: reload ? 'reload' : 'default' });
      if (res.ok) {
        const buf = await res.clone().arrayBuffer();
        await cache.put(url, res);
        return buf.byteLength;
      }
      if (res.status === 404) return 'err';
    } catch { if (sig.aborted) return 'err'; } finally {
      clearTimeout(timer);
      sig.removeEventListener('abort', stop);
    }
    await sleep(700 * (att + 1), sig);
  }
  return 'err';
}

const CONCURRENCY = 6;

async function downloadTiles(tiles: Tile[], opts: { reload: boolean; sig: AbortSignal; onProgress: (n: number, total: number) => void }): Promise<Result> {
  const cache = await caches.open(OFFLINE_CACHE);
  const have = opts.reload ? new Set<string>() : new Set((await cache.keys()).map((r) => r.url));
  const r: Result = { done: 0, skipped: 0, errors: 0, bytes: 0, aborted: false };
  // Свой сигнал: его прерывает и пользователь (opts.sig), и «источник не отвечает».
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  opts.sig.addEventListener('abort', onAbort);
  if (opts.sig.aborted) stop.abort();
  let i = 0, fin = 0, failRun = 0;
  const worker = async () => {
    while (i < tiles.length && !stop.signal.aborted) {
      const t = tiles[i++], url = tileUrl(t);
      if (have.has(url)) r.skipped++;
      else {
        const b = await fetchTile(url, cache, stop.signal, opts.reload);
        if (b === 'err') {
          if (!stop.signal.aborted) {
            r.errors++;
            if (++failRun >= SOURCE_DOWN_AFTER && !r.done) { r.sourceDown = true; stop.abort(); }
          }
        } else { r.done++; r.bytes += b; failRun = 0; }
      }
      opts.onProgress(++fin, tiles.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));
  } finally {
    opts.sig.removeEventListener('abort', onAbort);
  }
  r.aborted = opts.sig.aborted;
  return r;
}

/** Замер среднего размера тайла на нескольких реальных тайлах (в кеш района они не кладутся). */
let measuredAvg = 0;
let measureTried = false;
async function measureAvg(tiles: Tile[]): Promise<number> {
  if (measuredAvg || !tiles.length) return measuredAvg || DEFAULT_TILE_BYTES;
  const pick = [0, 1, 2, 3, 4, 5, 6].map((k) => tiles[Math.floor(((k + 0.5) / 7) * tiles.length)]).filter(Boolean);
  // Только замер размера: в кеш района не пишем, иначе тайлы вне района останутся «сиротами».
  const size = async (url: string): Promise<number | null> => {
    try { const r = await fetch(url, { mode: 'cors' }); return r.ok ? (await r.arrayBuffer()).byteLength : null; } catch { return null; }
  };
  const sizes = (await Promise.all(pick.map((t) => size(tileUrl(t))))).filter((v): v is number => v !== null);
  if (sizes.length >= 3) measuredAvg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return measuredAvg || DEFAULT_TILE_BYTES;
}

async function cacheStats(): Promise<{ n: number; bytes: number }> {
  const cache = await caches.open(OFFLINE_CACHE);
  const keys = await cache.keys();
  let bytes = 0, known = 0;
  for (let i = 0; i < keys.length; i += 40) {
    await Promise.all(keys.slice(i, i + 40).map(async (k) => {
      const r = await cache.match(k);
      const len = Number(r?.headers.get('content-length'));
      if (len > 0) { bytes += len; known++; }
    }));
  }
  if (known < keys.length) bytes += (keys.length - known) * (measuredAvg || DEFAULT_TILE_BYTES);
  return { n: keys.length, bytes };
}

// ---------- Граница района на карте ----------
function circle(lat: number, lon: number, km: number): GeoJSON.Feature {
  const ring: [number, number][] = [];
  for (let a = 0; a <= 360; a += 5) { const p = destination({ lat, lon }, a, km * 1000); ring.push([p.lon, p.lat]); }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} };
}
function showAreaOnMap(a: Area) {
  const data = fc([circle(a.lat, a.lon, a.km)]);
  if (!map.getSource('offline-area')) {
    map.addSource('offline-area', { type: 'geojson', data });
    const before = map.getStyle().layers.find((l) => l.id.startsWith('ov-'))?.id;
    map.addLayer({ id: 'offline-area', type: 'line', source: 'offline-area', paint: { 'line-color': '#4fbf72', 'line-width': 2.5, 'line-dasharray': [3, 2] } }, before);
  } else setGeo('offline-area', data);
  const c = circle(a.lat, a.lon, a.km).geometry as GeoJSON.LineString;
  const xs = c.coordinates.map((p) => p[0]), ys = c.coordinates.map((p) => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, duration: 600 });
}

/** Сколько тайлов ещё не скачано, сколько это места и сколько свободно (без квоты — Infinity). */
async function spaceFor(tiles: Tile[]): Promise<{ newN: number; need: number; free: number }> {
  let newN = tiles.length;
  try {
    const have = new Set((await (await caches.open(OFFLINE_CACHE)).keys()).map((r) => r.url));
    newN = tiles.filter((t) => !have.has(tileUrl(t))).length;
  } catch { /* ignore */ }
  let free = Infinity;
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota) free = e.quota - (e.usage ?? 0); } catch { /* ignore */ }
  return { newN, need: estimateBytes(newN, measuredAvg || DEFAULT_TILE_BYTES), free };
}

// ---------- Шторка ----------
let job: { ctl: AbortController; text: string } | null = null;
let selKm = 10, selCalc = true, selView = true;
let renderFn: (() => void) | null = null;
/** Подписчики на ход скачивания (кнопка в шторке пульта): начало, проценты, конец. */
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((f) => f());

const cachesOk = () => typeof caches !== 'undefined' && typeof caches.open === 'function';

/** Идёт ли скачивание района: проценты или null. */
export const offlineJobText = (): string | null => job?.text ?? null;
/** Отменить скачивание района (уже скачанное сохраняется). */
export const cancelOfflineJob = (): void => { job?.ctl.abort(); };
/** Следить за скачиванием района; возвращает отписку. */
export function onOfflineJob(f: () => void): () => void {
  watchers.add(f);
  return () => { watchers.delete(f); };
}

/** again — кнопка, которой докачать остальное (в итоговом сообщении). */
async function runDownload(area: Area, reload: boolean, again = 'Обновить') {
  // Район с прежнего источника: его план уровней (мог быть z14) — под старые тайлы; перекачиваем по нынешнему плану.
  if (area.src !== DEM_SRC_ID) area.layers = planLayers(area.lat, area.lon, area.km, area.calc, area.view);
  const tiles = enumerateTiles(area.lat, area.lon, area.layers);
  const ctl = new AbortController();
  job = { ctl, text: '0%' };
  renderFn?.(); notify();
  try { await navigator.storage?.persist?.(); } catch { /* не критично */ }
  progress(0, 'Скачиваю рельеф: 0%');
  let res: Result;
  try {
    res = await downloadTiles(tiles, {
      reload, sig: ctl.signal,
      onProgress: (n, total) => {
        const pc = `${Math.floor((n / total) * 100)}%`;
        if (job && job.text !== pc) { job.text = pc; notify(); }
        progress(n / total, `Скачиваю рельеф: ${pc}`);
      },
    });
  } catch (e) {
    toast(`Не удалось скачать: ${e instanceof Error ? e.message : 'хранилище браузера недоступно'}. Проверьте сеть и свободное место, затем нажмите «Скачать» ещё раз`, 6000);
    return;
  } finally {
    // Состояние сбрасываем всегда, иначе зависший job блокирует скачивание до перезагрузки.
    progress(null);
    job = null;
    renderFn?.(); notify();
  }
  const avg = measuredAvg || DEFAULT_TILE_BYTES;
  area.tiles = tiles.length;
  area.bytes = Math.round(res.bytes + res.skipped * avg);
  area.ts = Date.now();
  area.src = DEM_SRC_ID;
  area.complete = !res.aborted && !res.errors;
  // Ничего не скачано (отмена сразу, источник не отвечает) — пустой район в списке не нужен.
  if (res.done + res.skipped > 0) {
    const cur = loadAreas();
    const k = cur.findIndex((x) => x.id === area.id);
    if (k >= 0) cur[k] = area; else cur.push(area);
    saveAreas(cur);
    // Скачанный район — данные, которые браузер не должен вытеснять при нехватке места (без запроса пользователю
    // в Chrome; где не поддерживается — просто ничего).
    void navigator.storage?.persist?.().catch(() => false);
    emit('offline'); // строка связи: «офлайн ✓» / «вне скачанных районов»
  }
  toast(downloadVerdict(res, `~${fmtBytes(Math.max(area.bytes, 1))}`, again), 8000);
  renderFn?.(); notify();
}

// ---------- «Подготовить без сети» ----------
const PREP = 'Подготовить без сети';
const SOURCE_DOWN_TEXT = 'Источник рельефа (Mapterhorn) сейчас не отвечает — без него район для работы без сети не скачать (запасной источник годится только для расчёта по сети). Попробуйте другую сеть (Wi‑Fi) или чуть позже';
let starting = false;

/** Готовность района вокруг пульта к работе без сети — одной фразой (шторки пульта и «Офлайн»). */
export function prepNote(): string {
  const st = S.station;
  if (!st) return 'Поставьте пульт — район скачивается вокруг него';
  const zone = Math.round(S.coverage.radius / 1000);
  const s = prepState(loadAreas(), st, S.coverage.radius);
  return s === 'ready' ? `Готово: рельеф вокруг пульта скачан — расчёт и зона ${zone} км работают без сети`
    : s === 'edge' ? `Пульт в скачанном районе, но зона ${zone} км выходит за его край — нажмите «${PREP}»`
      : `Без сети здесь расчёт не работает: рельеф вокруг пульта не скачан`;
}

/**
 * Одной кнопкой перед выездом: офлайн-район вокруг пульта радиусом зоны (вверх до ближайшего из RADII_KM)
 * с данными для расчёта и карты — тем же механизмом, что «Скачать» в шторке «Офлайн».
 */
export async function prepareOffline(): Promise<void> {
  const st = S.station;
  if (!st) { toast('Сначала поставьте пульт — район скачивается вокруг него'); return; }
  if (!cachesOk()) { toast('В этом браузере офлайн недоступен. Откройте приложение по адресу https:// в Chrome или установите его на телефон', 6000); return; }
  if (job || starting) { toast(`Уже скачиваю рельеф района${job ? `: ${job.text}` : ''}`); return; }
  if (navigator.onLine === false) { toast('Нет сети — подготовить район можно только с интернетом', 5000); return; }
  if (primaryDown()) { toast(SOURCE_DOWN_TEXT, 8000); return; }
  starting = true;
  try {
    const c = { lat: st.lat, lon: st.lon };
    const { km, layers } = prepLayers(c.lat, c.lon, S.coverage.radius);
    // Тот же район (пульт на месте, тот же радиус) — обновляем его запись, а не плодим дубли.
    const prev = loadAreas().find((a) => a.calc && a.view && a.km === km && a.src === DEM_SRC_ID && distance(a, c) < 50);
    const lay = prev ? dedupLayers([...prev.layers, ...layers]) : layers;
    const tiles = enumerateTiles(prev?.lat ?? c.lat, prev?.lon ?? c.lon, lay);
    const sp = await spaceFor(tiles);
    if (sp.need * 1.1 >= sp.free) {
      toast(`Не хватит места: нужно ~${fmtBytes(sp.need)}, свободно ${fmtBytes(Math.max(0, sp.free))}. Удалите старые районы (Меню → Офлайн)`, 7000);
      return;
    }
    const area: Area = prev ? { ...prev, layers: lay, tiles: tiles.length } : {
      id: `o${Date.now().toString(36)}`, name: `У пульта ${km} км · ${new Date().toLocaleDateString('ru-RU')}`,
      lat: c.lat, lon: c.lon, km, calc: true, view: true, layers: lay, tiles: tiles.length, bytes: 0, ts: Date.now(), src: DEM_SRC_ID,
    };
    starting = false;
    await runDownload(area, false, PREP);
  } finally {
    starting = false;
  }
}

/** Шторка «Офлайн-районы»: скачать рельеф района вокруг пульта/прицела, список, удаление, занятое место. */
export function openOfflineSheet(): void {
  const body = h('<div class="off"></div>');
  openSheet('Офлайн-районы', body, () => { renderFn = null; });
  if (!cachesOk()) {
    body.innerHTML = '<p class="off-warn">В этом браузере офлайн недоступен. Откройте приложение по адресу https:// в Chrome или установите его на телефон («Добавить на главный экран»).</p>';
    return;
  }
  let plan = { n: 0, newN: 0, need: 0, free: Infinity, msg: '', ok: true, busy: true };
  let planId = 0;
  let stats = '';

  const origin = () => (S.station ? { lat: S.station.lat, lon: S.station.lon, src: 'пульт' } : { ...center(), src: 'прицел' });

  async function recompute() {
    const my = ++planId;
    plan = { ...plan, busy: true };
    const o = origin();
    const layers = planLayers(o.lat, o.lon, selKm, selCalc, selView);
    const tiles = enumerateTiles(o.lat, o.lon, layers);
    const avg = measuredAvg || DEFAULT_TILE_BYTES;
    const { newN, need, free } = await spaceFor(tiles);
    if (my !== planId) return;
    const ok = layers.length > 0 && need * 1.1 < free;
    plan = { n: tiles.length, newN, need, free, ok, busy: false, msg: layers.length ? (ok ? '' : `Не хватит места: нужно ~${fmtBytes(need)}, свободно ${Number.isFinite(free) ? fmtBytes(free) : '?'}. Уменьшите радиус, снимите «Для карты» или удалите старый район`) : 'Отметьте хотя бы одно: «Для расчёта связи» или «Для карты»' };
    render();
    // Замер — один раз за сессию; пересчёт после него тоже один (иначе recompute → measureAvg → recompute…).
    if (!measuredAvg && !measureTried && tiles.length) {
      measureTried = true;
      measureAvg(tiles).then((avgNew) => { if (my === planId && measuredAvg && avgNew !== avg) recompute(); }).catch(() => {});
    }
  }

  function render() {
    body.innerHTML = '';
    // Перед выездом — одной кнопкой: район вокруг пульта радиусом зоны, для расчёта и карты.
    const prep = h(`<div class="off-prep"><p class="off-sum"><b>Перед выездом</b> — рельеф вокруг пульта для расчёта и карты: ${prepRadiusKm(S.coverage.radius)} км (зона ${Math.round(S.coverage.radius / 1000)} км).</p>
      <p class="hint off-prep-note">${escapeHtml(prepNote())}</p><div class="row"></div></div>`);
    const pb = button(PREP, 'primary', () => { void prepareOffline(); });
    pb.id = 'offPrep';
    pb.disabled = !S.station || !!job;
    prep.querySelector('.row')!.appendChild(pb);
    body.appendChild(prep);
    body.appendChild(h('<h4 class="off-sec">Свой район</h4>'));
    const o = origin();
    body.appendChild(h(`<p class="off-sum">Рельеф вокруг ${o.src === 'пульт' ? 'пульта' : 'прицела'} — расчёт связи будет работать без сети. Радиус:</p>`));
    body.appendChild(chips(RADII_KM.map((km) => ({ text: `${km} км`, on: km === selKm, click: () => { selKm = km; recompute(); render(); } }))));
    const checks = h(`<div class="off-checks">
      <label><input type="checkbox" id="offCalc" ${selCalc ? 'checked' : ''}><span>Для расчёта связи<small>профиль, строка связи, зона</small></span></label>
      <label><input type="checkbox" id="offView" ${selView ? 'checked' : ''}><span>Для карты<small>горизонтали и отмывка; займёт больше места</small></span></label></div>`);
    (checks.querySelector('#offCalc') as HTMLInputElement).onchange = (e) => { selCalc = (e.target as HTMLInputElement).checked; recompute(); render(); };
    (checks.querySelector('#offView') as HTMLInputElement).onchange = (e) => { selView = (e.target as HTMLInputElement).checked; recompute(); render(); };
    body.appendChild(checks);
    body.appendChild(h(plan.busy
      ? '<p class="hint">Считаю объём…</p>'
      : `<p class="off-sum">Скачать ~${fmtBytes(plan.need)}${plan.newN < plan.n ? ' (часть уже есть)' : ''} · свободно ${Number.isFinite(plan.free) ? fmtBytes(plan.free) : 'неизвестно'}</p>`));
    if (plan.msg) body.appendChild(h(`<p class="off-warn">${escapeHtml(plan.msg)}</p>`));
    const row = h('<div class="row"></div>');
    if (job) {
      const cancel = h(`<button class="ghost" type="button">Отменить (${escapeHtml(job.text)})</button>`);
      cancel.onclick = () => job?.ctl.abort();
      row.appendChild(cancel);
    } else {
      const go = h('<button class="primary" type="button">Скачать</button>');
      (go as HTMLButtonElement).disabled = plan.busy || !plan.ok || plan.n === 0;
      go.onclick = () => {
        const layers = planLayers(o.lat, o.lon, selKm, selCalc, selView);
        const tiles = enumerateTiles(o.lat, o.lon, layers).length;
        const area: Area = {
          id: `o${Date.now().toString(36)}`, name: `Район ${selKm} км · ${new Date().toLocaleDateString('ru-RU')}`,
          lat: o.lat, lon: o.lon, km: selKm, calc: selCalc, view: selView, layers, tiles, bytes: 0, ts: Date.now(), src: DEM_SRC_ID,
        };
        runDownload(area, false);
      };
      row.appendChild(go);
    }
    body.appendChild(row);
    body.appendChild(h('<p class="hint off-note"><b>Подложка не сохраняется</b> — только рельеф. Без сети спутник и топокарта не покажутся; для них добавьте свою карту (Меню → Офлайн → Свои карты).</p>'));

    body.appendChild(h('<h4 class="off-sec">Скачанные районы</h4>'));
    const list = loadAreas();
    if (!list.length) body.appendChild(h('<p class="hint">Пока нет.</p>'));
    for (const a of list) {
      const lv = [a.calc ? 'расчёт' : '', a.view ? 'карта' : ''].filter(Boolean).join(' + ');
      // Скачан с прежнего источника рельефа: эти тайлы приложение больше не читает — нужно перекачать.
      const old = a.src !== DEM_SRC_ID ? '<div class="off-meta"><b>Рельеф обновился — нажмите «Обновить», чтобы район снова работал без сети</b></div>' : '';
      const it = h(`<div class="off-item"><b>${escapeHtml(a.name)}</b><div class="off-meta">${a.km} км · ${lv} · ~${fmtBytes(a.bytes)}</div>${old}<div class="row"></div></div>`);
      const r = it.querySelector('.row')!;
      const mk = (t: string, cls: string, f: () => void) => r.appendChild(button(t, cls, f));
      mk('Показать', 'ghost', () => showAreaOnMap(a));
      mk('Обновить', 'ghost', () => { if (job) { toast('Дождитесь конца скачивания'); return; } runDownload({ ...a }, true); });
      mk('Удалить', 'danger', async () => {
        if (job) { toast('Дождитесь конца скачивания'); return; }
        if (!(await confirmDialog('Удалить район?', `«${a.name}» перестанет работать без сети.`, 'Удалить'))) return;
        try {
          const cache = await caches.open(OFFLINE_CACHE);
          const keys = exclusiveKeys(a, list.filter((o2) => o2.id !== a.id));
          await Promise.all(keys.map((k) => cache.delete(keyToUrl(k))));
          saveAreas(loadAreas().filter((x) => x.id !== a.id));
          emit('offline');
          toast('Район удалён');
        } catch (e) {
          toast(`Не удалось удалить район: ${e instanceof Error ? e.message : 'хранилище браузера недоступно'}. Перезапустите приложение и попробуйте снова`, 6000);
        }
        recompute(); refreshStats(); render();
      });
      body.appendChild(it);
    }
    body.appendChild(h('<h4 class="off-sec">Место на устройстве</h4>'));
    body.appendChild(h(`<p class="off-sum" id="offStats">${escapeHtml(stats || 'Считаю…')}</p>`));
    const tail = h('<div class="row"></div>');
    const pers = button('Защитить от очистки', 'ghost', async () => {
      const ok = await navigator.storage?.persist?.().catch(() => false);
      toast(ok ? 'Готово: браузер не удалит офлайн-данные сам' : 'Браузер не разрешил. Установите приложение на телефон и попробуйте снова', 5000);
    });
    const clr = button('Удалить всё', 'danger', async () => {
      if (job) { toast('Дождитесь конца скачивания'); return; }
      if (!(await confirmDialog('Удалить все районы?', 'Весь скачанный рельеф и список районов удалятся с устройства.', 'Удалить всё'))) return;
      try {
        await caches.delete(OFFLINE_CACHE);
        saveAreas([]);
        emit('offline');
        toast('Офлайн-районы удалены');
      } catch (e) {
        toast(`Не удалось очистить: ${e instanceof Error ? e.message : 'хранилище браузера недоступно'}. Перезапустите приложение и попробуйте снова`, 6000);
      }
      stats = ''; recompute(); refreshStats(); render();
    });
    tail.append(pers);
    if (list.length) tail.append(clr);
    body.appendChild(tail);
  }

  async function refreshStats() {
    try {
      const s = await cacheStats();
      const e = await navigator.storage?.estimate?.();
      stats = `Рельеф: ${s.n ? `~${fmtBytes(s.bytes)}` : 'нет'}${e?.quota ? ` · всего занято ${fmtBytes(e.usage ?? 0)} из ${fmtBytes(e.quota)}` : ''}`;
      const el = document.getElementById('offStats');
      if (el) el.textContent = stats;
    } catch { stats = 'Не удалось узнать занятое место'; }
  }

  renderFn = () => { render(); void recompute(); void refreshStats(); };
  render();
  void recompute();
  void refreshStats();
}
