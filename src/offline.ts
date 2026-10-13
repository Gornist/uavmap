// Офлайн-районы: скачивание тайлов рельефа для района в Cache Storage. Владелец: задача B.
// Кеш 'uavmap-dem-v1': ключ — полный URL тайла, значение — ответ fetch(url, { mode: 'cors' }).
// Service Worker (агент A) отдаёт тайлы DEM оттуда в первую очередь.
import './styles/offline.css';
import { S, map, center, openSheet, progress, toast, h, escapeHtml, fc, setGeo } from './app';
import { DEM_URL, DEM_MAX_Z, demPlan } from './elevation';
import { destination } from './geo';

export const OFFLINE_CACHE = 'uavmap-dem-v1';
export const OFFLINE_KEY = 'uavmap.offline.v1';
export const RADII_KM = [5, 10, 20, 40];
/** Средний тайл Terrarium (грубая оценка, уточняется замером). */
export const DEFAULT_TILE_BYTES = 90 * 1024;
const VIEW_Z0 = 8, VIEW_Z1 = 13; // maplibre-contour: maxzoom 13; hillshade берёт те же тайлы
const COV_MAX_TILES = 256; // как MAX_TILES в coverage.ts
const PAD_PX = 16; // запас по краю: окно максимума и билинейная выборка выходят за радиус

// ---------- Чистые функции ----------
export interface Layer { z: number; km: number }
export interface Area {
  id: string; name: string; lat: number; lon: number; km: number;
  calc: boolean; view: boolean; layers: Layer[]; tiles: number; bytes: number; ts: number;
}
export interface Tile { z: number; x: number; y: number }

export const tileKey = (t: Tile) => `${t.z}/${t.x}/${t.y}`;
export const tileUrl = (t: Tile) => DEM_URL.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));

const MAX_LAT = 85.0511287798;

/** Диапазон тайлов, накрывающий круг радиуса km (+ запас). X не обёрнут (может выходить за [0, 2^z)), Y обрезан. */
export function tileRange(lat: number, lon: number, km: number, z: number): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** z;
  const dLat = (km * 1000) / 6371008.8 * (180 / Math.PI);
  const cosL = Math.max(0.01, Math.cos(Math.min(Math.abs(lat) + dLat, 89.9) * Math.PI / 180));
  const dLon = Math.min(180, dLat / cosL);
  const padT = PAD_PX / 256;
  const fx = (lo: number) => ((lo + 180) / 360) * n;
  const fy = (la: number) => {
    const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, la)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  };
  const x0 = Math.floor(fx(lon - dLon) - padT), x1 = Math.floor(fx(lon + dLon) + padT);
  const y0 = Math.max(0, Math.floor(fy(lat + dLat) - padT)), y1 = Math.min(n - 1, Math.floor(fy(lat - dLat) + padT));
  return { x0, x1: Math.min(x1, x0 + n - 1), y0, y1 };
}

/** Все тайлы набора слоёв {z, km} вокруг точки: без дублей, X обёрнут по антимеридиану. */
export function enumerateTiles(lat: number, lon: number, layers: Layer[]): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (const { z, km } of layers) {
    const n = 2 ** z;
    const r = tileRange(lat, lon, km, z);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let xr = r.x0; xr <= r.x1; xr++) {
        const t = { z, x: ((xr % n) + n) % n, y };
        const k = tileKey(t);
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      }
    }
  }
  return out;
}

export function countTiles(lat: number, lon: number, km: number, z: number): number {
  const r = tileRange(lat, lon, km, z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

export const estimateBytes = (tiles: number, avg = DEFAULT_TILE_BYTES) => Math.round(tiles * avg);

/** Слои района: «расчёт» (зум профиля/зоны для радиусов ≤ R) и «карта» (z 8..13 по bbox района). */
export function planLayers(lat: number, km: number, calc: boolean, view: boolean): Layer[] {
  const out: Layer[] = [];
  if (calc) {
    out.push({ z: demPlan(lat, km * 1000).z, km }); // профиль до любой точки района
    for (const r of RADII_KM.filter((v) => v <= km)) { // зона покрытия радиуса r
      out.push({ z: demPlan(lat, r * 1000, (zz) => countTiles(lat, 0, r, zz), COV_MAX_TILES).z, km: r });
    }
  }
  if (view) for (let z = VIEW_Z0; z <= VIEW_Z1; z++) out.push({ z, km });
  // Слой (z, km) с тем же z и меньшим радиусом входит в больший — убираем дубли.
  return out.filter((a, i) => !out.some((b, j) => j !== i && b.z === a.z && (b.km > a.km || (b.km === a.km && j < i))));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Разбор метаданных из localStorage: повреждённое отбрасывается. */
export function parseAreas(raw: string | null): Area[] {
  if (!raw) return [];
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  const arr = isObj(j) && Array.isArray(j.areas) ? j.areas : Array.isArray(j) ? j : [];
  const out: Area[] = [];
  const ids = new Set<string>();
  for (const a of arr) {
    if (!isObj(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id) || typeof a.name !== 'string') continue;
    if (!num(a.lat, -90, 90) || !num(a.lon, -180, 180) || !num(a.km, 0.1, 1000)) continue;
    if (!Array.isArray(a.layers) || !a.layers.length) continue;
    const layers: Layer[] = [];
    let bad = false;
    for (const l of a.layers) {
      if (isObj(l) && num(l.z, 0, DEM_MAX_Z) && Number.isInteger(l.z) && num(l.km, 0.1, 1000)) layers.push({ z: l.z, km: l.km }); else bad = true;
    }
    if (bad) continue;
    if (!num(a.tiles, 0, 1e7) || !num(a.bytes, 0, 1e12) || !num(a.ts, 0, 1e14)) continue;
    ids.add(a.id);
    out.push({ id: a.id, name: a.name.slice(0, 80), lat: a.lat, lon: a.lon, km: a.km, calc: a.calc === true, view: a.view === true, layers, tiles: a.tiles, bytes: a.bytes, ts: a.ts });
  }
  return out;
}

/** Ключи тайлов района, которые не нужны ни одному другому району. */
export function exclusiveKeys(area: Area, others: Area[]): string[] {
  const used = new Set<string>();
  for (const o of others) for (const t of enumerateTiles(o.lat, o.lon, o.layers)) used.add(tileKey(t));
  return enumerateTiles(area.lat, area.lon, area.layers).map(tileKey).filter((k) => !used.has(k));
}

export const keyToUrl = (k: string) => { const [z, x, y] = k.split('/'); return tileUrl({ z: +z, x: +x, y: +y }); };

export function fmtBytes(b: number): string {
  return b >= 1048576 ? `${(b / 1048576).toFixed(b >= 1.07e8 ? 0 : 1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`;
}

// ---------- Хранилище метаданных ----------
function loadAreas(): Area[] {
  try { return parseAreas(localStorage.getItem(OFFLINE_KEY)); } catch { return []; }
}
function saveAreas(a: Area[]) {
  try { localStorage.setItem(OFFLINE_KEY, JSON.stringify({ v: 1, areas: a })); } catch { /* переполнение/запрет — не критично */ }
}

// ---------- Скачивание ----------
const sleep = (ms: number, sig?: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  sig?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

interface Result { done: number; skipped: number; errors: number; bytes: number; aborted: boolean }

async function fetchTile(url: string, cache: Cache, sig: AbortSignal, reload: boolean): Promise<number | 'err'> {
  for (let att = 0; att < 3; att++) {
    if (sig.aborted) return 'err';
    try {
      const res = await fetch(url, { mode: 'cors', signal: sig, cache: reload ? 'reload' : 'default' });
      if (res.ok) {
        const buf = await res.clone().arrayBuffer();
        await cache.put(url, res);
        return buf.byteLength;
      }
      if (res.status === 404) return 'err';
    } catch { if (sig.aborted) return 'err'; }
    await sleep(700 * (att + 1), sig);
  }
  return 'err';
}

const CONCURRENCY = 6;

async function downloadTiles(tiles: Tile[], opts: { reload: boolean; sig: AbortSignal; onProgress: (n: number, total: number) => void }): Promise<Result> {
  const cache = await caches.open(OFFLINE_CACHE);
  const have = opts.reload ? new Set<string>() : new Set((await cache.keys()).map((r) => r.url));
  const r: Result = { done: 0, skipped: 0, errors: 0, bytes: 0, aborted: false };
  let i = 0, fin = 0;
  const worker = async () => {
    while (i < tiles.length && !opts.sig.aborted) {
      const t = tiles[i++], url = tileUrl(t);
      if (have.has(url)) r.skipped++;
      else {
        const b = await fetchTile(url, cache, opts.sig, opts.reload);
        if (b === 'err') { if (!opts.sig.aborted) r.errors++; } else { r.done++; r.bytes += b; }
      }
      opts.onProgress(++fin, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));
  r.aborted = opts.sig.aborted;
  return r;
}

/** Замер среднего размера тайла на нескольких реальных тайлах (они же сразу кладутся в кеш). */
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

// ---------- Шторка ----------
let job: { ctl: AbortController; text: string } | null = null;
let selKm = 10, selCalc = true, selView = true;
let renderFn: (() => void) | null = null;

const cachesOk = () => typeof caches !== 'undefined' && typeof caches.open === 'function';

async function runDownload(area: Area, reload: boolean) {
  const tiles = enumerateTiles(area.lat, area.lon, area.layers);
  const ctl = new AbortController();
  job = { ctl, text: 'Загрузка…' };
  renderFn?.();
  try { await navigator.storage?.persist?.(); } catch { /* не критично */ }
  progress(0, `Офлайн: 0/${tiles.length}`);
  let res: Result;
  try {
    res = await downloadTiles(tiles, {
      reload, sig: ctl.signal,
      onProgress: (n, total) => { job!.text = `${n}/${total}`; progress(n / total, `Офлайн: ${n}/${total}`); },
    });
  } catch (e) {
    toast(`Не удалось скачать: ${e instanceof Error ? e.message : 'хранилище браузера недоступно'}`, 5000);
    return;
  } finally {
    // Состояние сбрасываем всегда, иначе зависший job блокирует скачивание до перезагрузки.
    progress(null);
    job = null;
    renderFn?.();
  }
  const avg = measuredAvg || DEFAULT_TILE_BYTES;
  area.tiles = tiles.length;
  area.bytes = Math.round(res.bytes + res.skipped * avg);
  area.ts = Date.now();
  if (!res.aborted || res.done + res.skipped > 0) {
    const cur = loadAreas();
    const k = cur.findIndex((x) => x.id === area.id);
    if (k >= 0) cur[k] = area; else cur.push(area);
    saveAreas(cur);
  }
  toast(res.aborted ? `Отменено: скачано ${res.done}` : `Скачано ${res.done}, пропущено ${res.skipped}, ошибок ${res.errors}`, 5000);
  renderFn?.();
}

/** Шторка «Офлайн-районы»: скачать район вокруг прицела/пульта, список, удаление, занятое место. */
export function openOfflineSheet(): void {
  const body = h('<div></div>');
  openSheet('Офлайн-районы', body, () => { renderFn = null; });
  if (!cachesOk()) {
    body.innerHTML = '<p class="off-warn">Офлайн-режим недоступен: браузер не даёт Cache Storage. Откройте приложение по https:// (или localhost) в современном браузере.</p>';
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
    const layers = planLayers(o.lat, selKm, selCalc, selView);
    const tiles = enumerateTiles(o.lat, o.lon, layers);
    let newN = tiles.length;
    try {
      const have = new Set((await (await caches.open(OFFLINE_CACHE)).keys()).map((r) => r.url));
      newN = tiles.filter((t) => !have.has(tileUrl(t))).length;
    } catch { /* ignore */ }
    if (my !== planId) return;
    const avg = measuredAvg || DEFAULT_TILE_BYTES;
    let free = Infinity;
    try { const e = await navigator.storage?.estimate?.(); if (e?.quota) free = e.quota - (e.usage ?? 0); } catch { /* ignore */ }
    const need = estimateBytes(newN, avg);
    const ok = layers.length > 0 && need * 1.1 < free;
    plan = { n: tiles.length, newN, need, free, ok, busy: false, msg: layers.length ? (ok ? '' : `Не хватит места: нужно ~${fmtBytes(need)}, свободно ${Number.isFinite(free) ? fmtBytes(free) : '?'}`) : 'Выберите хотя бы один уровень' };
    render();
    // Замер — один раз за сессию; пересчёт после него тоже один (иначе recompute → measureAvg → recompute…).
    if (!measuredAvg && !measureTried && tiles.length) {
      measureTried = true;
      measureAvg(tiles).then((avgNew) => { if (my === planId && measuredAvg && avgNew !== avg) recompute(); }).catch(() => {});
    }
  }

  function render() {
    body.innerHTML = '';
    const o = origin();
    body.appendChild(h(`<div class="off-sum">Рельеф вокруг: ${o.src === 'пульт' ? 'пульта' : 'прицела'}. Радиус:</div>`));
    const chips = h('<div class="chips"></div>');
    for (const km of RADII_KM) {
      const b = h(`<button class="${km === selKm ? 'on' : ''}">${km} км</button>`);
      b.onclick = () => { selKm = km; recompute(); render(); };
      chips.appendChild(b);
    }
    body.appendChild(chips);
    const checks = h(`<div class="off-checks">
      <label><input type="checkbox" id="offCalc" ${selCalc ? 'checked' : ''}><span>Для расчёта связи</span></label>
      <label><input type="checkbox" id="offView" ${selView ? 'checked' : ''}><span>Для карты (горизонтали, отмывка)<small>масштабы ${VIEW_Z0}–${VIEW_Z1}</small></span></label></div>`);
    (checks.querySelector('#offCalc') as HTMLInputElement).onchange = (e) => { selCalc = (e.target as HTMLInputElement).checked; recompute(); render(); };
    (checks.querySelector('#offView') as HTMLInputElement).onchange = (e) => { selView = (e.target as HTMLInputElement).checked; recompute(); render(); };
    body.appendChild(checks);
    const avgNote = measuredAvg ? `средний тайл ${fmtBytes(measuredAvg)} (замер)` : `средний тайл ~${fmtBytes(DEFAULT_TILE_BYTES)} (оценка)`;
    body.appendChild(h(plan.busy
      ? '<div class="hint">Считаю…</div>'
      : `<div class="off-sum">Скачать ~${fmtBytes(plan.need)} · свободно ${Number.isFinite(plan.free) ? fmtBytes(plan.free) : 'неизвестно'}</div><div class="hint muted">Тайлов: ${plan.n}, новых: ${plan.newN}; ${avgNote}.</div>`));
    if (plan.msg) body.appendChild(h(`<div class="off-warn">${escapeHtml(plan.msg)}</div>`));
    const row = h('<div class="row"></div>');
    if (job) {
      const cancel = h(`<button class="ghost">Отмена (${escapeHtml(job.text)})</button>`);
      cancel.onclick = () => job?.ctl.abort();
      row.appendChild(cancel);
    } else {
      const go = h('<button class="primary">Скачать</button>');
      (go as HTMLButtonElement).disabled = plan.busy || !plan.ok || plan.n === 0;
      go.onclick = () => {
        const layers = planLayers(o.lat, selKm, selCalc, selView);
        const tiles = enumerateTiles(o.lat, o.lon, layers).length;
        const area: Area = {
          id: `o${Date.now().toString(36)}`, name: `Район ${selKm} км · ${new Date().toLocaleDateString('ru-RU')}`,
          lat: o.lat, lon: o.lon, km: selKm, calc: selCalc, view: selView, layers, tiles, bytes: 0, ts: Date.now(),
        };
        runDownload(area, false);
      };
      row.appendChild(go);
    }
    body.appendChild(row);
    body.appendChild(h('<div class="hint">Скачивается только рельеф (Mapzen Terrain Tiles); спутник и схемы — нет.</div>'));

    body.appendChild(h('<div class="off-sec">Скачанные районы</div>'));
    const list = loadAreas();
    if (!list.length) body.appendChild(h('<div class="hint">Пока нет скачанных районов.</div>'));
    for (const a of list) {
      const lv = [a.calc ? 'расчёт' : '', a.view ? 'карта' : ''].filter(Boolean).join(' + ');
      const it = h(`<div class="off-item"><b>${escapeHtml(a.name)}</b><div class="off-meta">${a.km} км · ${lv} · ${a.tiles} тайлов · ~${fmtBytes(a.bytes)}<br>${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}</div><div class="row"></div></div>`);
      const r = it.querySelector('.row')!;
      const mk = (t: string, f: () => void) => { const b = h(`<button class="ghost">${t}</button>`); b.onclick = f; r.appendChild(b); };
      mk('Показать', () => showAreaOnMap(a));
      mk('Обновить', () => { if (!job) runDownload({ ...a }, true); });
      mk('Удалить', async () => {
        if (job) return;
        const cache = await caches.open(OFFLINE_CACHE);
        const keys = exclusiveKeys(a, list.filter((o2) => o2.id !== a.id));
        await Promise.all(keys.map((k) => cache.delete(keyToUrl(k))));
        saveAreas(loadAreas().filter((x) => x.id !== a.id));
        toast(`Удалено тайлов: ${keys.length}`);
        recompute(); refreshStats(); render();
      });
      body.appendChild(it);
    }
    body.appendChild(h('<div class="off-sec">Занято</div>'));
    body.appendChild(h(`<div class="off-sum" id="offStats">${stats || 'Считаю…'}</div>`));
    const clr = h('<button class="ghost">Очистить всё</button>');
    clr.onclick = async () => {
      if (job || !confirm('Удалить все скачанные тайлы рельефа и список районов?')) return;
      await caches.delete(OFFLINE_CACHE);
      saveAreas([]);
      toast('Офлайн-данные удалены');
      stats = ''; recompute(); refreshStats(); render();
    };
    body.appendChild(clr);
    const pers = h('<button class="ghost">Не удалять при нехватке места</button>');
    pers.onclick = async () => {
      const ok = await navigator.storage?.persist?.().catch(() => false);
      toast(ok ? 'Данные защищены от автоматической очистки' : 'Браузер не разрешил (попробуйте после установки приложения)', 4000);
    };
    body.appendChild(pers);
  }

  async function refreshStats() {
    try {
      const s = await cacheStats();
      const e = await navigator.storage?.estimate?.();
      stats = `В кеше рельефа: ${s.n} тайлов, ~${fmtBytes(s.bytes)}${e?.quota ? `. Всего использовано ${fmtBytes(e.usage ?? 0)} из ${fmtBytes(e.quota)}` : ''}`;
      const el = document.getElementById('offStats');
      if (el) el.textContent = stats;
    } catch { stats = 'Не удалось прочитать кеш'; }
  }

  renderFn = () => { render(); void recompute(); void refreshStats(); };
  render();
  void recompute();
  void refreshStats();
}
