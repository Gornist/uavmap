// Зона покрытия на карте. Владелец: карточка 1B (docs/PLAN.md).
// Запуск coverage.worker.ts, растровая накладка, граница связи, таблица «высота → дальность».
import './styles/coverage.css';
import type { ImageSource } from 'maplibre-gl';
import { S, h, map, setGeo, fc, line, toast, openSheet, closeSheet, progress, on, persist } from './app';
import { destination, distance, bearing, lonLatToPixel, pixelToLonLat, fmtDist, LatLon } from './geo';
import { fetchGrid, demPlan, demPixelM, demQualityHint, DemMissingError } from './elevation';
import { budget, freeSpaceRange } from './radio';
import { setStation, altModeText, effRadio, effVideo } from './link';
import type { CoverageJob, CoverageResult } from './coverageCore';

const RADII = [5, 10, 15, 25, 40];
const MAX_TILES = 256; // ≈ 64 МБ Float32
const CANVAS = 768;
const RZ = 20; // «виртуальный» зум для равномерных меркаторских пикселей растра
const PALETTE = ['#b8e986', '#7ed957', '#2fbf8f', '#22a3b8', '#3b7fd6', '#5a5bd0', '#7b3fbf', '#9c27a0'];

interface Shown {
  res: CoverageResult;
  center: LatLon; radius: number; step: number; rays: number; heights: number[];
  fade: number; // порог, с которым считался firstLoss — растр и статистика используют его же
  resV: CoverageResult | null; // линия «Видео» (null — при расчёте она была выключена)
  fadeV: number;
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
}

function revokeLater(url: string | null) {
  if (url) setTimeout(() => URL.revokeObjectURL(url), 5000); // даём MapLibre дочитать картинку
}

function cancelRun() {
  runId++;
  workers.forEach((w) => w.terminate());
  workers = [];
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

function paint(c: Shown): HTMLCanvasElement {
  const L = rasterBounds!;
  const cv = document.createElement('canvas');
  cv.width = L.w; cv.height = L.hh;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(L.w, L.hh);
  const px = img.data;
  const { samples } = c.res;
  const level = levelAt(c, lineOf(c));
  const nH = c.heights.length, rays = c.rays;
  const sel = Math.min(S.coverage.heightIdx, nH - 1);
  const minh = S.coverage.show === 'minh';
  const p: LatLon = { lat: 0, lon: 0 };
  for (let j = 0; j < L.hh; j++) {
    const py = L.y0 + ((j + 0.5) * L.wy) / L.hh;
    for (let i = 0; i < L.w; i++) {
      const [lon, lat] = pixelToLonLat(L.x0 + ((i + 0.5) * L.wx) / L.w, py, RZ);
      p.lat = lat; p.lon = lon;
      const d = distance(c.center, p);
      const sIdx = Math.round(d / c.step);
      if (d > c.radius || sIdx >= samples) continue;
      const r = Math.round((bearing(c.center, p) / 360) * rays) % rays;
      const o = (j * L.w + i) * 4;
      if (!minh) {
        const lv = level(sel, r, sIdx);
        if (lv === 2) { px[o] = 79; px[o + 1] = 191; px[o + 2] = 114; px[o + 3] = 255; }
        else if (lv === 1) { px[o] = 227; px[o + 1] = 185; px[o + 2] = 72; px[o + 3] = 255; }
        else { px[o] = 229; px[o + 1] = 72; px[o + 2] = 77; px[o + 3] = 70; }
      } else {
        let k = -1;
        for (let hi = 0; hi < nH; hi++) if (level(hi, r, sIdx) === 2) { k = hi; break; }
        if (k < 0) { px[o] = px[o + 1] = px[o + 2] = 128; px[o + 3] = 40; continue; }
        const col = PAL_RGB[nH === 1 ? 0 : Math.round((k / (nH - 1)) * (PAL_RGB.length - 1))];
        px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
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
  running = true;
  progress(0, 'Загрузка рельефа…');
  rerender?.();
  try {
    const grid = await fetchGrid([
      { lat: box.n, lon: box.w }, { lat: box.n, lon: box.e },
      { lat: box.s, lon: box.e }, { lat: box.s, lon: box.w },
    ], z, pad);
    if (id !== runId) return;
    const rays = heights.length <= 2 ? 720 : 360;
    const mkJob = (rp: typeof radio, g: typeof grid): CoverageJob => ({
      grid: g, lat: center.lat, lon: center.lon, antH: st.antH, heights, mode,
      radius, step, rays, freqMHz: rp.freqMHz, budget: budget(rp), k: rp.k, fade: rp.fadeMarginDb,
    });
    // Частота влияет на дифракцию, поэтому у видео отдельный прогон; линии считаются параллельно в двух воркерах
    // (каждому — своя копия сетки: буфер передаётся воркеру, а не копируется).
    const jobs = [mkJob(radio, vRadio ? { ...grid, data: grid.data.slice() } : grid)];
    if (vRadio) jobs.push(mkJob(vRadio, grid));
    const progs = jobs.map(() => 0);
    progress(0, 'Расчёт…');
    const runWorker = (job: CoverageJob, idx: number) => new Promise<CoverageResult>((resolve, reject) => {
      const wk = new Worker(new URL('./coverage.worker.ts', import.meta.url), { type: 'module' });
      workers.push(wk);
      wk.onmessage = (ev: MessageEvent<{ progress?: number; done?: CoverageResult; error?: string }>) => {
        if (id !== runId) return;
        const m = ev.data;
        if (m.progress !== undefined) {
          progs[idx] = m.progress;
          const p = progs.reduce((x, y) => x + y, 0) / jobs.length;
          progress(p, `Расчёт ${Math.round(p * 100)}%`);
          return;
        }
        wk.terminate();
        if (m.error) reject(new Error(m.error)); else if (m.done) resolve(m.done);
      };
      wk.onerror = (ev) => { if (id === runId) { wk.terminate(); reject(new Error(ev.message)); } };
      wk.postMessage(job, [job.grid.data.buffer]);
    });
    const [res, resV] = await Promise.all(jobs.map(runWorker));
    if (id !== runId) return;
    workers = []; running = false; progress(null);
    shown = { res, resV: resV ?? null, center, radius, step, rays, heights, fade: jobs[0].fade, fadeV: jobs[1]?.fade ?? 0 };
    stale = rev !== inputsRev; // входные данные менялись во время расчёта
    S.coverage.heightIdx = Math.min(S.coverage.heightIdx, heights.length - 1);
    redraw();
    rerender?.();
  } catch (err) {
    if (id !== runId) return;
    workers.forEach((w) => w.terminate()); workers = [];
    running = false; progress(null);
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

export function openCoverageSheet(): void {
  const body = openSheet('Зона покрытия', '', () => { if (sheetBody === body) { sheetBody = null; rerender = null; } });
  sheetBody = body;
  rerender = render;
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

  body.appendChild(sec('Радиус расчёта'));
  body.appendChild(chips(RADII.map((km) => ({
    text: `${km} км`, on: cov.radius === km * 1000, click: () => { cov.radius = km * 1000; saveInput(); },
  }))));

  body.appendChild(sec('Высоты дрона над ' + (S.altMode === 'takeoff' ? 'точкой взлёта' : 'рельефом') + ', м'));
  const hs = chips(cov.heights.map((v, i) => ({
    text: `${v} ×`, cls: 'x', click: () => {
      if (cov.heights.length <= 1) { toast('Нужна хотя бы одна высота'); return; }
      cov.heights.splice(i, 1);
      cov.heightIdx = Math.min(cov.heightIdx, cov.heights.length - 1);
      saveInput();
    },
  })));
  body.appendChild(hs);
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
  body.appendChild(add);
  body.appendChild(hint(`Отсчёт высоты: ${altModeText()}.`));

  body.appendChild(sec('Показывать'));
  const seg = h('<div class="seg"><button type="button">Запас на высоте</button><button type="button">Мин. высота полёта</button></div>');
  const [b1, b2] = Array.from(seg.querySelectorAll('button'));
  (cov.show === 'margin' ? b1 : b2).classList.add('on');
  b1.onclick = () => { cov.show = 'margin'; persist(); redraw(); render(); };
  b2.onclick = () => { cov.show = 'minh'; persist(); redraw(); render(); };
  body.appendChild(seg);

  if (shown?.resV) {
    body.appendChild(sec('Линия'));
    const ls = h('<div class="seg"></div>');
    for (const [id, t] of [['rc', 'Управление'], ['video', 'Видео'], ['both', 'Обе (по худшей)']] as const) {
      const b = h('<button type="button"></button>');
      b.textContent = t;
      if (cov.line === id) b.classList.add('on');
      b.onclick = () => { cov.line = id; persist(); redraw(); render(); };
      ls.appendChild(b);
    }
    body.appendChild(ls);
  }

  if (cov.show === 'margin') {
    const hsel = shown ? shown.heights : cov.heights;
    body.appendChild(chips(hsel.map((v, i) => ({
      text: `${v} м`, on: i === Math.min(cov.heightIdx, hsel.length - 1),
      click: () => { cov.heightIdx = i; persist(); redraw(); render(); },
    }))));
  }

  body.appendChild(sec('Прозрачность накладки'));
  const op = h(`<input type="range" class="cov-opacity" min="0.1" max="1" step="0.05" value="${cov.opacity}">`) as HTMLInputElement;
  op.oninput = () => {
    cov.opacity = Number(op.value);
    if (map.getLayer('cov-raster')) map.setPaintProperty('cov-raster', 'raster-opacity', cov.opacity);
  };
  op.onchange = persist;
  body.appendChild(op);

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
      const x = h('<button type="button" class="ghost">Убрать</button>');
      x.onclick = () => clearCoverage();
      row.appendChild(x);
    }
  }
  body.appendChild(row);

  const q = demQualityHint(S.station.lat);
  if (q) body.appendChild(hint(q));
  body.appendChild(hint(S.video.enabled
    ? `Дальность в свободном пространстве без рельефа: управление ${fmtDist(freeSpaceRange(effRadio()))}, видео ${fmtDist(freeSpaceRange(effVideo()))}`
    : `Дальность в свободном пространстве без рельефа: ${fmtDist(freeSpaceRange(effRadio()))}`));
  if (shown && stale) body.appendChild(hint('Пульт, радиопараметры или набор линий изменились — результат устарел, пересчитайте.', 'cov-stale'));
  if (shown) renderResult(body, shown);
  const done = h('<div class="row"><button type="button" class="ghost">Закрыть</button></div>');
  done.querySelector('button')!.onclick = closeSheet;
  body.appendChild(done);
}

function renderResult(body: HTMLElement, c: Shown) {
  const line = lineOf(c);
  const legend = h('<div class="legend"></div>');
  const okTxt = line === 'both' ? 'обе линии ≥ своего запаса' : `запас ≥ ${line === 'video' ? c.fadeV : c.fade} дБ`;
  const items = S.coverage.show === 'margin'
    ? [['#4fbf72', okTxt], ['#e3b948', line === 'both' ? 'худшая линия на грани' : 'на грани'], ['#e5484d', line === 'both' ? 'одна из линий потеряна' : 'нет связи']]
    : c.heights.map((v, i) => [PALETTE[c.heights.length === 1 ? 0 : Math.round((i / (c.heights.length - 1)) * (PALETTE.length - 1))], `от ${v} м`]);
  for (const [col, txt] of items) {
    const sp = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = col;
    sp.append(i, txt);
    legend.appendChild(sp);
  }
  body.appendChild(legend);

  const cols: { name: string; line: Line }[] = c.resV
    ? [{ name: 'Упр.', line: 'rc' }, { name: 'Видео', line: 'video' }, { name: 'Обе', line: 'both' }]
    : [{ name: '', line: 'rc' }];
  const sts = cols.map((x) => stats(c, x.line));
  const t = h(c.resV
    ? '<table class="rt"><thead><tr><th>Высота</th><th>Упр.</th><th>Видео</th><th>Обе</th></tr></thead><tbody></tbody></table>'
    : '<table class="rt"><thead><tr><th>Высота</th><th>Медиана</th><th>Макс.</th><th>Площадь</th></tr></thead><tbody></tbody></table>');
  const tb = t.querySelector('tbody')!;
  const sel = Math.min(S.coverage.heightIdx, c.heights.length - 1);
  c.heights.forEach((hv, i) => {
    const tr = document.createElement('tr');
    if (S.coverage.show === 'margin' && i === sel) tr.classList.add('sel');
    const td = (txt: string) => { const x = document.createElement('td'); x.textContent = txt; tr.appendChild(x); return x; };
    td(`${hv} м`);
    if (c.resV) {
      for (const st of sts) {
        const x = td(fmtDist(st[i].median));
        const sm = document.createElement('small');
        sm.textContent = `макс. ${fmtDist(st[i].max)} · ${Math.round(st[i].share * 100)}%`;
        x.append(document.createElement('br'), sm);
      }
    } else {
      const st = sts[0][i];
      td(fmtDist(st.median)); td(fmtDist(st.max)); td(`${Math.round(st.share * 100)}%`);
    }
    tr.onclick = () => { S.coverage.show = 'margin'; S.coverage.heightIdx = i; persist(); redraw(); render(); };
    tb.appendChild(tr);
  });
  body.appendChild(t);
  body.appendChild(hint(c.resV
    ? 'В ячейке: медиана до первого обрыва по лучам, ниже — максимум и доля круга с уверенной связью. «Обе» — по худшей линии (минимум запасов относительно своих порогов).'
    : 'Медиана — до первого обрыва по лучам; площадь — доля круга с уверенной связью.'));
}
