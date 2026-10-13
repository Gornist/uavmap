// Зона покрытия на карте. Владелец: карточка 1B (docs/PLAN.md).
// Запуск coverage.worker.ts, растровая накладка, граница связи, таблица «высота → дальность».
import './styles/coverage.css';
import type { ImageSource } from 'maplibre-gl';
import { S, h, map, setGeo, fc, line, toast, openSheet, closeSheet, progress, on, persist } from './app';
import { destination, lonLatToPixel, pixelToLonLat, LatLon } from './geo';
import { rasterIndex } from './coverageRaster';
import { fetchGrid, demPlan, demPixelM, demQualityHint, DemMissingError, DemGrid } from './elevation';
import { budget, freeSpaceRange } from './radio';
import { setStation, effRadio, effVideo, km as fmtKm, ICON, statusRgb, onThemeChange } from './link';
import { emptyResult, mergeChunk, sectorCrop, splitRays } from './coverageCore';
import type { CoverageChunk, CoverageLine, CoverageResult } from './coverageCore';
// ?worker: Vite выбирает формат сам — модуль в dev, классический воркер в сборке (Chrome 68 не умеет module workers).
import CoverageWorker from './coverage.worker?worker';

const RADII = [5, 10, 15, 25, 40];
const MAX_TILES = 256; // ≈ 64 МБ Float32
const CANVAS = 768;
const RZ = 20; // «виртуальный» зум для равномерных меркаторских пикселей растра
// Воркеров на расчёт: ядро оставляем странице. Лучи делятся на части (по 3 на воркер — для выравнивания нагрузки),
// каждой части — вырезка мозаики под её сектор (≈ 1/8 площади), так что память почти не растёт с числом воркеров.
const POOL = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
const PARTS_PER_WORKER = 3;
const PRELIM_TILES = 16; // предварительный проход: грубый рельеф не больше стольких тайлов
const PALETTE = ['#b8e986', '#7ed957', '#2fbf8f', '#22a3b8', '#3b7fd6', '#5a5bd0', '#7b3fbf', '#9c27a0'];

interface Shown {
  res: CoverageResult;
  center: LatLon; radius: number; step: number; rays: number; heights: number[];
  fade: number; // порог, с которым считался firstLoss — растр и статистика используют его же
  resV: CoverageResult | null; // линия «Видео» (null — при расчёте она была выключена)
  fadeV: number;
  prelim: boolean; // предварительный грубый проход (лучей ×¼, шаг ×2), полный ещё считается
}

type Line = 'rc' | 'video' | 'both';
/** Что показывать: если видео не считалось — только управление. */
const lineOf = (c: Shown): Line => (c.resV ? S.coverage.line : 'rc');
/** Уровень связи: 0 — нет, 1 — на грани, 2 — уверенно (относительно собственного порога линии). */
const lvl = (m: number, fade: number) => (m >= fade ? 2 : m >= 0 ? 1 : 0);

/** Уровень в точке (высота hi, луч r, отсчёт s) для линии; «обе» = минимум уровней — по худшей. */
function levelAt(c: Shown, line: Line) {
  const { samples } = c.res, rays = c.rays;
  const a = line !== 'video' ? c.res.margins : null;
  const b = line !== 'rc' && c.resV ? c.resV.margins : null;
  return (hi: number, r: number, s: number) => {
    const o = (hi * rays + r) * samples + s;
    let l = 2;
    if (a) l = lvl(a[o], c.fade);
    if (b) l = Math.min(l, lvl(b[o], c.fadeV));
    return l;
  };
}

/** Расстояние до первого обрыва; для «обеих» — минимум из двух линий. */
function firstLossAt(c: Shown, line: Line, hi: number, r: number): number {
  const i = hi * c.rays + r;
  const a = c.res.firstLoss[i], b = c.resV ? c.resV.firstLoss[i] : Infinity;
  return line === 'rc' || !c.resV ? a : line === 'video' ? b : Math.min(a, b);
}

let shown: Shown | null = null;
let stale = false;
let workers: Worker[] = [];
let runId = 0;
let inputsRev = 0; // растёт при каждом изменении пульта/радио — для проверки свежести результата
let running = false;
let curUrl: string | null = null;
let sheetBody: HTMLElement | null = null;
let rerender: (() => void) | null = null;
type Quad = [[number, number], [number, number], [number, number], [number, number]];
let rasterBounds: { coords: Quad; x0: number; y0: number; wx: number; wy: number; w: number; hh: number } | null = null;

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const PAL_RGB = PALETTE.map(rgb);

/** Первый слой других модулей (ov-*) — свои слои вставляем под ним. */
function beforeOv(): string | undefined {
  return map.getStyle().layers.find((l) => l.id.startsWith('ov-'))?.id;
}

export function initCoverage(): void {
  map.addSource('cov-edge', { type: 'geojson', data: fc() });
  map.addLayer({
    id: 'cov-edge', type: 'line', source: 'cov-edge',
    paint: { 'line-color': '#e3a948', 'line-width': 2, 'line-dasharray': [3, 2] },
  }, beforeOv());
  const markStale = () => {
    inputsRev++;
    if (!shown) return;
    stale = true;
    rerender?.();
  };
  on('station', markStale);
  on('radio', markStale);
  // Смена темы может сменить цвета статусов: перерисовать растр (кеш цветов в link.ts сбрасывается раньше — его подписка создаётся при импорте).
  onThemeChange(() => { if (shown) redraw(); rerender?.(); });
}

function revokeLater(url: string | null) {
  if (url) setTimeout(() => URL.revokeObjectURL(url), 5000); // даём MapLibre дочитать картинку
}

/** Пул воркеров живёт между расчётами (запуск воркера — десятки мс); прерывается только идущий расчёт. */
function ensurePool() {
  while (workers.length < POOL) workers.push(new CoverageWorker());
}

function cancelRun() {
  runId++;
  if (running) { workers.forEach((w) => w.terminate()); workers = []; }
  running = false;
  progress(null);
}

export function clearCoverage(): void {
  cancelRun();
  shown = null;
  stale = false;
  rasterBounds = null;
  if (map.getLayer('cov-raster')) map.removeLayer('cov-raster');
  if (map.getSource('cov')) map.removeSource('cov');
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  setGeo('cov-edge', fc());
  rerender?.();
}

// ---------- растр ----------
function layoutRaster(c: Shown) {
  const n = destination(c.center, 0, c.radius), s = destination(c.center, 180, c.radius);
  const e = destination(c.center, 90, c.radius), w = destination(c.center, 270, c.radius);
  const [x0, y0] = lonLatToPixel(w.lon, n.lat, RZ);
  const [x1, y1] = lonLatToPixel(e.lon, s.lat, RZ);
  const wx = x1 - x0, wy = y1 - y0;
  const wPx = wx >= wy ? CANVAS : Math.max(8, Math.round((CANVAS * wx) / wy));
  const hPx = wx >= wy ? Math.max(8, Math.round((CANVAS * wy) / wx)) : CANVAS;
  const nw = pixelToLonLat(x0, y0, RZ), ne = pixelToLonLat(x1, y0, RZ);
  const se = pixelToLonLat(x1, y1, RZ), sw = pixelToLonLat(x0, y1, RZ);
  return { coords: [nw, ne, se, sw] as Quad, x0, y0, wx, wy, w: wPx, hh: hPx };
}

// Геометрия пикселей растра кешируется: смена высоты/линии/режима её не пересчитывает.
let pixCache: { key: string; idx: Int32Array } | null = null;
function pixelIndex(c: Shown, L: NonNullable<typeof rasterBounds>): Int32Array {
  const g = { lat: c.center.lat, lon: c.center.lon, radius: c.radius, rays: c.rays, step: c.step, samples: c.res.samples, x0: L.x0, y0: L.y0, wx: L.wx, wy: L.wy, w: L.w, h: L.hh, z: RZ };
  const key = Object.values(g).join();
  if (pixCache?.key !== key) pixCache = { key, idx: rasterIndex(g) };
  return pixCache.idx;
}

let paintMs = 0;
function paint(c: Shown): HTMLCanvasElement {
  const t0 = performance.now();
  const L = rasterBounds!;
  const cv = document.createElement('canvas');
  cv.width = L.w; cv.height = L.hh;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(L.w, L.hh);
  const px = img.data;
  const idx = pixelIndex(c, L);
  const ln = lineOf(c);
  const a = ln !== 'video' ? c.res.margins : null;
  const b = ln !== 'rc' && c.resV ? c.resV.margins : null;
  const fa = c.fade, fb = c.fadeV;
  const level = (o: number) => {
    let l = 2;
    if (a) l = lvl(a[o], fa);
    if (b) l = Math.min(l, lvl(b[o], fb));
    return l;
  };
  const nH = c.heights.length, HS = c.rays * c.res.samples;
  const sel = Math.min(S.coverage.heightIdx, nH - 1);
  const minh = S.coverage.show === 'minh';
  const col = statusRgb(); // цвета статусов из темы (--ok/--weak/--none)
  const cOk = col.ok, cWeak = col.weak, cNone = col.none;
  for (let p = 0, o = 0; p < idx.length; p++, o += 4) {
    const k = idx[p];
    if (k < 0) continue;
    if (!minh) {
      const lv = level(sel * HS + k);
      const cc = lv === 2 ? cOk : lv === 1 ? cWeak : cNone;
      px[o] = cc[0]; px[o + 1] = cc[1]; px[o + 2] = cc[2]; px[o + 3] = lv === 0 ? 70 : 255;
    } else {
      let hk = -1;
      for (let hi = 0; hi < nH; hi++) if (level(hi * HS + k) === 2) { hk = hi; break; }
      if (hk < 0) { px[o] = px[o + 1] = px[o + 2] = 128; px[o + 3] = 40; continue; }
      const col = PAL_RGB[nH === 1 ? 0 : Math.round((hk / (nH - 1)) * (PAL_RGB.length - 1))];
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  paintMs = performance.now() - t0;
  return cv;
}

function drawEdge(c: Shown) {
  const hi = Math.min(S.coverage.heightIdx, c.heights.length - 1);
  const pts: [number, number][] = [];
  const ln = lineOf(c);
  for (let r = 0; r < c.rays; r++) {
    const q = destination(c.center, (360 * r) / c.rays, firstLossAt(c, ln, hi, r));
    pts.push([q.lon, q.lat]);
  }
  if (pts.length) pts.push(pts[0]);
  setGeo('cov-edge', fc(pts.length ? [line(pts)] : []));
}

let drawSeq = 0;
function redraw() {
  if (!shown) return;
  const c = shown;
  rasterBounds = layoutRaster(c);
  const coords = rasterBounds.coords;
  const seq = ++drawSeq;
  paint(c).toBlob((blob) => {
    if (!blob || seq !== drawSeq || shown !== c) return;
    const url = URL.createObjectURL(blob);
    const old = curUrl;
    curUrl = url;
    const src = map.getSource('cov') as ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates: coords });
    else {
      map.addSource('cov', { type: 'image', url, coordinates: coords });
      map.addLayer({
        id: 'cov-raster', type: 'raster', source: 'cov',
        paint: { 'raster-opacity': S.coverage.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
      }, map.getLayer('cov-edge') ? 'cov-edge' : beforeOv());
    }
    revokeLater(old);
  }, 'image/png');
  drawEdge(c);
}

// ---------- расчёт ----------
function tilesFor(box: { w: number; e: number; n: number; s: number }, z: number) {
  const [x0, y0] = lonLatToPixel(box.w, box.n, z);
  const [x1, y1] = lonLatToPixel(box.e, box.s, z);
  const cols = Math.floor((x1 + 2) / 256) - Math.floor((x0 - 2) / 256) + 1;
  const rows = Math.floor((y1 + 2) / 256) - Math.floor((y0 - 2) / 256) + 1;
  return cols * rows;
}

/** Посчитать все лучи частями в пуле воркеров; результат по каждой линии собран в полные массивы. */
let chunkSeq = 0;
function runPass(id: number, base: Omit<CoverageChunk, 'grid' | 'r0' | 'r1'>, grid: DemGrid, parts: number, onProgress?: (f: number) => void): Promise<CoverageResult[]> {
  ensurePool();
  const nH = base.heights.length, nS = Math.floor(base.radius / base.step) + 1;
  const out = base.lines.map(() => emptyResult(nH, base.rays, nS));
  const queue = splitRays(base.rays, parts);
  let left = queue.length, doneRays = 0, failed = false;
  const inFlight = new Map<number, number>(); // часть → посчитано лучей
  const report = () => {
    if (!onProgress) return;
    let x = doneRays;
    inFlight.forEach((v) => { x += v; });
    onProgress(x / base.rays);
  };
  return new Promise((resolve, reject) => {
    const fail = (msg: string) => { if (id === runId && !failed) { failed = true; reject(new Error(msg)); } };
    const next = (wk: Worker) => {
      const part = queue.shift();
      if (!part || failed || id !== runId) return;
      const [r0, r1] = part, cid = ++chunkSeq;
      const chunk: CoverageChunk = { ...base, grid: sectorCrop(grid, base.lat, base.lon, base.rays, r0, r1, base.radius, base.step), r0, r1 };
      wk.onmessage = (ev: MessageEvent<{ id: number; progress?: number; done?: CoverageResult[]; error?: string }>) => {
        const m = ev.data;
        if (id !== runId || failed || m.id !== cid) return;
        if (m.progress !== undefined) { inFlight.set(cid, m.progress * (r1 - r0)); report(); return; }
        inFlight.delete(cid);
        if (m.error || !m.done) { fail(m.error || 'нет результата'); return; }
        m.done.forEach((r, li) => mergeChunk(out[li], r, nH, base.rays, r0, r1));
        doneRays += r1 - r0;
        report();
        if (--left === 0) resolve(out); else next(wk);
      };
      wk.onerror = (ev) => fail(ev.message || 'сбой воркера');
      wk.postMessage({ id: cid, chunk }, [chunk.grid.data.buffer]);
    };
    workers.forEach(next);
  });
}

/** Показать результат (предварительный или окончательный). */
function show(c: Shown, rev: number) {
  shown = c;
  stale = rev !== inputsRev; // входные данные менялись во время расчёта
  S.coverage.heightIdx = Math.min(S.coverage.heightIdx, c.heights.length - 1);
  redraw();
  rerender?.();
}

async function start() {
  if (running || !S.station) return;
  const st = { ...S.station };
  const center: LatLon = { lat: st.lat, lon: st.lon };
  const heights = [...S.coverage.heights];
  const radius = S.coverage.radius;
  const n = destination(center, 0, radius), s = destination(center, 180, radius);
  const e = destination(center, 90, radius), w = destination(center, 270, radius);
  const box = { w: w.lon, e: e.lon, n: n.lat, s: s.lat };
  // Круг через меридиан 180°: долготы «переворачиваются», и мозаика раздулась бы на весь мир.
  if (box.e < box.w || Math.abs(box.n) > 84 || Math.abs(box.s) > 84) {
    toast('Зона через меридиан 180° или у полюса пока не поддерживается');
    return;
  }
  const { z, step } = demPlan(center.lat, radius, (zz) => tilesFor(box, zz), MAX_TILES);
  const pad = Math.ceil(step / demPixelM(center.lat, z)) + 2; // окно максимума выходит за радиус на step/2

  const id = ++runId;
  const rev = inputsRev;
  // Снимок радиопараметров до await: иначе старый пульт смешается с новыми настройками.
  const radio = { ...effRadio() }, mode = S.altMode; // копия: effRadio() может вернуть сам S.radio
  const vRadio = S.video.enabled ? { ...effVideo() } : null;
  // Частота влияет на дифракцию, поэтому у видео свой прогон; обе линии считаются в одной части на одной вырезке.
  const lines: CoverageLine[] = [radio, ...(vRadio ? [vRadio] : [])].map((rp) => ({ freqMHz: rp.freqMHz, budget: budget(rp), k: rp.k, fade: rp.fadeMarginDb }));
  const rays = heights.length <= 2 ? 720 : 360;
  const base = { lat: center.lat, lon: center.lon, antH: st.antH, heights, mode, radius, step, rays, exact: false, lines };
  const mkShown = (r: CoverageResult[], stp: number, ry: number, prelim: boolean): Shown => ({
    res: r[0], resV: r[1] ?? null, center, radius, step: stp, rays: ry, heights, fade: lines[0].fade, fadeV: lines[1]?.fade ?? 0, prelim,
  });
  running = true;
  const T0 = performance.now();
  const stats: Record<string, number> = { z, step, rays };
  progress(0, 'Загрузка рельефа…');
  rerender?.();
  const corners = [
    { lat: box.n, lon: box.w }, { lat: box.n, lon: box.e },
    { lat: box.s, lon: box.e }, { lat: box.s, lon: box.w },
  ];
  // Предварительный проход (лучей ×¼, шаг ×2): на точном рельефе, если он уже в кеше, иначе — на грубом
  // (несколько тайлов, запрашиваются первыми), пока точный догружается. Без грубого (офлайн) — ждём точный.
  const stepP = step * 2, raysP = rays / 4;
  let zc = Math.max(8, z - 2);
  while (zc > 8 && tilesFor(box, zc) > PRELIM_TILES) zc--;
  const coarseP = zc < z ? fetchGrid(corners, zc, Math.ceil(stepP / demPixelM(center.lat, zc)) + 2) : null;
  let computing = false;
  const fineP = fetchGrid(corners, z, pad, (d, t) => { if (id === runId && !computing) progress(d / t, `Загрузка рельефа ${d}/${t}`); });
  fineP.catch(() => undefined); // ошибку разберём ниже, при ожидании
  try {
    const gP = await Promise.race(coarseP ? [fineP, coarseP.catch(() => fineP)] : [fineP]);
    if (id !== runId) return;
    stats.prelimZ = gP.z;
    computing = true;
    progress(0, 'Предварительный расчёт…');
    const resP = await runPass(id, { ...base, step: stepP, rays: raysP }, gP, POOL);
    if (id !== runId) return;
    show(mkShown(resP, stepP, raysP, true), rev);
    stats.prelim = performance.now() - T0;
    computing = false;
    const grid = await fineP;
    if (id !== runId) return;
    const T1 = performance.now();
    stats.dem = T1 - T0;
    computing = true;
    progress(0, 'Расчёт…');
    const res = await runPass(id, base, grid, POOL * PARTS_PER_WORKER, (f) => progress(f, `Расчёт ${Math.round(f * 100)}%`));
    if (id !== runId) return;
    const T2 = performance.now();
    running = false; progress(null);
    show(mkShown(res, step, rays, false), rev);
    stats.calc = T2 - T1;
    stats.total = performance.now() - T0;
    stats.paint = paintMs;
    if (import.meta.env.DEV) (window as unknown as { __covStats: unknown }).__covStats = stats;
  } catch (err) {
    if (id !== runId) return;
    cancelRun();
    toast(err instanceof DemMissingError ? err.message : `Ошибка расчёта: ${err instanceof Error ? err.message : err}`, 4000);
    rerender?.();
  }
}

// ---------- статистика ----------
function stats(c: Shown, line: Line) {
  const { samples } = c.res;
  const level = levelAt(c, line);
  return c.heights.map((_, hi) => {
    const fl: number[] = [];
    for (let r = 0; r < c.rays; r++) fl.push(firstLossAt(c, line, hi, r));
    fl.sort((a, b) => a - b);
    let good = 0, total = 0;
    for (let r = 0; r < c.rays; r++) {
      for (let k = 1; k < samples; k++) { total += k; if (level(hi, r, k) === 2) good += k; }
    }
    return { median: fl[fl.length >> 1] ?? 0, max: fl[fl.length - 1] ?? 0, share: total ? good / total : 0 };
  });
}

// ---------- шторка ----------
function chips(items: { text: string; on?: boolean; click: () => void; cls?: string }[]) {
  const box = h('<div class="chips"></div>');
  for (const it of items) {
    const b = h('<button type="button"></button>');
    b.textContent = it.text;
    if (it.on) b.classList.add('on');
    if (it.cls) b.classList.add(it.cls);
    b.onclick = it.click;
    box.appendChild(b);
  }
  return box;
}

function sec(text: string) {
  const d = h('<div class="cov-sec"></div>');
  d.textContent = text;
  return d;
}

function hint(text: string, cls = 'hint') {
  const d = h(`<div class="${cls}"></div>`);
  d.textContent = text;
  return d;
}

// Раскрытые блоки шторки переживают перерисовку.
let openSettings = false, openMore = false;
function details(title: string, isOpen: boolean, onToggle: (v: boolean) => void): { el: HTMLDetailsElement; body: HTMLElement } {
  const el = document.createElement('details');
  el.className = 'details';
  el.open = isOpen;
  const s = document.createElement('summary');
  s.textContent = title;
  el.appendChild(s);
  el.addEventListener('toggle', () => onToggle(el.open));
  return { el, body: el };
}

export function openCoverageSheet(): void {
  const body = openSheet('Зона покрытия', '', () => { if (sheetBody === body) { sheetBody = null; rerender = null; } });
  sheetBody = body;
  rerender = render;
  ensurePool(); // воркеры успеют загрузиться, пока выбирают параметры
  render();
}

function render() {
  const body = sheetBody;
  if (!body) return;
  body.innerHTML = '';
  const cov = S.coverage;

  if (!S.station) {
    body.appendChild(hint('Сначала нужен пульт — точка, от которой считается связь.'));
    const b = h('<button type="button" class="primary">Поставить пульт в прицел</button>');
    b.onclick = () => {
      const c = map.getCenter();
      void setStation({ lat: c.lat, lon: c.lng }).then(render);
      render();
    };
    body.appendChild(b);
    toast('Пульт не поставлен');
    return;
  }

  const save = () => { persist(); render(); };
  // Радиус и высоты — входные данные расчёта: прежний результат устаревает.
  const saveInput = () => { inputsRev++; if (shown) stale = true; save(); };

  // ----- главное: радиус, высота, «Рассчитать», результат -----
  body.appendChild(sec('Радиус'));
  body.appendChild(chips(RADII.map((km) => ({
    text: `${km} км`, on: cov.radius === km * 1000, click: () => { cov.radius = km * 1000; saveInput(); },
  }))));

  if (cov.show === 'margin') {
    body.appendChild(sec(`Высота дрона ${S.altMode === 'takeoff' ? 'над точкой взлёта' : 'над рельефом'}`));
    const hsel = shown ? shown.heights : cov.heights;
    body.appendChild(chips(hsel.map((v, i) => ({
      text: `${v} м`, on: i === Math.min(cov.heightIdx, hsel.length - 1),
      click: () => { cov.heightIdx = i; persist(); redraw(); render(); },
    }))));
  }

  const row = h('<div class="row"></div>');
  if (running) {
    const c = h('<button type="button" class="ghost">Отмена</button>');
    c.onclick = () => { cancelRun(); render(); };
    row.appendChild(c);
  } else {
    const r = h('<button type="button" class="primary">Рассчитать</button>');
    r.onclick = () => { void start(); };
    row.appendChild(r);
    if (shown) {
      const x = h('<button type="button" class="ghost">Убрать с карты</button>');
      x.onclick = () => clearCoverage();
      row.appendChild(x);
    }
  }
  body.appendChild(row);

  if (shown?.prelim) body.appendChild(hint('Черновой расчёт — точный идёт, картинка обновится.', 'cov-prelim'));
  if (shown && stale) body.appendChild(hint('Пульт или настройки изменились — нажмите «Рассчитать» ещё раз.', 'cov-stale'));
  if (shown) renderSummary(body, shown);

  // ----- настройки зоны -----
  const st = details('Настройки зоны', openSettings, (v) => { openSettings = v; });
  const sb = st.body;
  sb.appendChild(sec('Высоты для расчёта, м'));
  sb.appendChild(chips(cov.heights.map((v, i) => ({
    text: `${v} ×`, cls: 'x', click: () => {
      if (cov.heights.length <= 1) { toast('Нужна хотя бы одна высота'); return; }
      cov.heights.splice(i, 1);
      cov.heightIdx = Math.min(cov.heightIdx, cov.heights.length - 1);
      saveInput();
    },
  }))));
  const add = h('<div class="cov-add"><input type="number" inputmode="numeric" min="1" max="5000" placeholder="м"><button type="button" class="ghost">Добавить</button></div>');
  const inp = add.querySelector('input')!;
  add.querySelector('button')!.onclick = () => {
    const v = Math.round(Number(inp.value));
    if (!(v >= 1 && v <= 5000)) { toast('Высота от 1 до 5000 м'); return; }
    if (cov.heights.includes(v)) { toast('Такая высота уже есть'); return; }
    if (cov.heights.length >= 8) { toast('Не больше 8 высот'); return; }
    cov.heights.push(v);
    cov.heights.sort((a, b) => a - b);
    saveInput();
  };
  sb.appendChild(add);

  sb.appendChild(sec('Что закрашивать'));
  const seg = h('<div class="seg"><button type="button">Связь на высоте</button><button type="button">Нужную высоту</button></div>');
  const [b1, b2] = Array.from(seg.querySelectorAll('button'));
  (cov.show === 'margin' ? b1 : b2).classList.add('on');
  b1.onclick = () => { cov.show = 'margin'; persist(); redraw(); render(); };
  b2.onclick = () => { cov.show = 'minh'; persist(); redraw(); render(); };
  sb.appendChild(seg);

  if (shown?.resV) {
    sb.appendChild(sec('По какой линии'));
    const ls = h('<div class="seg"></div>');
    for (const [id, t] of [['rc', 'Управление'], ['video', 'Видео'], ['both', 'Обе']] as const) {
      const b = h('<button type="button"></button>');
      b.textContent = t;
      if (cov.line === id) b.classList.add('on');
      b.onclick = () => { cov.line = id; persist(); redraw(); render(); };
      ls.appendChild(b);
    }
    sb.appendChild(ls);
  }

  sb.appendChild(sec('Прозрачность'));
  const op = h(`<input type="range" class="cov-opacity" min="0.1" max="1" step="0.05" value="${cov.opacity}">`) as HTMLInputElement;
  op.oninput = () => {
    cov.opacity = Number(op.value);
    if (map.getLayer('cov-raster')) map.setPaintProperty('cov-raster', 'raster-opacity', cov.opacity);
  };
  op.onchange = persist;
  sb.appendChild(op);
  const q = demQualityHint(S.station.lat);
  if (q) sb.appendChild(hint(q));
  body.appendChild(st.el);

  // ----- подробности -----
  if (shown) {
    const more = details('Подробнее', openMore, (v) => { openMore = v; });
    renderTable(more.body, shown);
    more.body.appendChild(hint(S.video.enabled
      ? `Без рельефа связь держалась бы до: управление ${fmtKm(freeSpaceRange(effRadio()))}, видео ${fmtKm(freeSpaceRange(effVideo()))}.`
      : `Без рельефа связь держалась бы до ${fmtKm(freeSpaceRange(effRadio()))}.`));
    body.appendChild(more.el);
  }

  const done = h('<div class="row"><button type="button" class="ghost">Закрыть</button></div>');
  done.querySelector('button')!.onclick = closeSheet;
  body.appendChild(done);
}

/** Главный результат словами + легенда. */
function renderSummary(body: HTMLElement, c: Shown) {
  const line = lineOf(c);
  if (S.coverage.show === 'margin') {
    const sel = Math.min(S.coverage.heightIdx, c.heights.length - 1);
    const st = stats(c, line)[sel];
    const res = h('<div class="verdict-big cov-result"></div>');
    res.textContent = `Связь держится до ${fmtKm(st.median)} (в среднем) — максимум ${fmtKm(st.max)}`;
    body.appendChild(res);
    const who = line === 'both' ? 'по худшей из двух линий' : line === 'video' ? 'по видео' : 'по управлению';
    body.appendChild(hint(`Дрон на ${c.heights[sel]} м, ${who}.`, 'hint muted'));
  }
  const legend = h('<div class="legend"></div>');
  const col = statusRgb();
  const css = (s: 'ok' | 'weak' | 'none') => `rgb(${col[s].join(',')})`;
  const items: [string, string][] = S.coverage.show === 'margin'
    ? [[css('ok'), `${ICON.ok} зелёный — связь есть`], [css('weak'), `${ICON.weak} жёлтый — на грани`], [css('none'), `${ICON.none} красный — нет связи`]]
    : c.heights.map((v, i) => [PALETTE[c.heights.length === 1 ? 0 : Math.round((i / (c.heights.length - 1)) * (PALETTE.length - 1))], `связь от ${v} м`] as [string, string]);
  for (const [cl, txt] of items) {
    const sp = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = cl;
    sp.append(i, txt);
    legend.appendChild(sp);
  }
  body.appendChild(legend);
}

function renderTable(body: HTMLElement, c: Shown) {
  const cols: { name: string; line: Line }[] = c.resV
    ? [{ name: 'Упр.', line: 'rc' }, { name: 'Видео', line: 'video' }, { name: 'Обе', line: 'both' }]
    : [{ name: '', line: 'rc' }];
  const sts = cols.map((x) => stats(c, x.line));
  const t = h(c.resV
    ? '<table class="rt"><thead><tr><th>Высота</th><th>Упр.</th><th>Видео</th><th>Обе</th></tr></thead><tbody></tbody></table>'
    : '<table class="rt"><thead><tr><th>Высота</th><th>В среднем</th><th>Максимум</th><th>Площадь</th></tr></thead><tbody></tbody></table>');
  const tb = t.querySelector('tbody')!;
  const sel = Math.min(S.coverage.heightIdx, c.heights.length - 1);
  c.heights.forEach((hv, i) => {
    const tr = document.createElement('tr');
    if (S.coverage.show === 'margin' && i === sel) tr.classList.add('sel');
    const td = (txt: string) => { const x = document.createElement('td'); x.className = 'num'; x.textContent = txt; tr.appendChild(x); return x; };
    td(`${hv} м`);
    if (c.resV) {
      for (const st of sts) {
        const x = td(fmtKm(st[i].median));
        const sm = document.createElement('small');
        sm.textContent = `макс. ${fmtKm(st[i].max)} · ${Math.round(st[i].share * 100)}%`;
        x.append(document.createElement('br'), sm);
      }
    } else {
      const st = sts[0][i];
      td(fmtKm(st.median)); td(fmtKm(st.max)); td(`${Math.round(st.share * 100)}%`);
    }
    tr.onclick = () => { S.coverage.show = 'margin'; S.coverage.heightIdx = i; persist(); redraw(); render(); };
    tb.appendChild(tr);
  });
  body.appendChild(t);
  body.appendChild(hint(c.resV
    ? 'В ячейке: дальность до первого обрыва в среднем по направлениям, ниже — максимум и доля круга, где связь есть. «Обе» — по худшей линии. Нажмите строку, чтобы показать эту высоту.'
    : 'В среднем — до первого обрыва по направлениям; площадь — доля круга, где связь есть. Нажмите строку, чтобы показать эту высоту.'));
}
