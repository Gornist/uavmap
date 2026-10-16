// Зона покрытия: запуск расчёта в пуле воркеров (coverage.worker.ts), предварительный и точный проходы,
// отмена, устаревание результата при смене пульта/радио. Владеет показанным результатом (shown).
// Смена одной лишь высоты дрона (S.droneH) результат не портит: если она посчитана — показываем её без пересчёта.
import { S, toast, progress, on } from './app';
import { LatLon } from './geo';
import { fetchGrid, coverageBox, coverageZoom, demPixelM, DemMissingError, DemGrid } from './elevation';
import { demTileCount } from './demTiles';
import { budget } from './radio';
import { directional } from './antenna';
import { effRadio, effVideo, effVideoOrNull } from './station';
import { emptyResult, mergeChunk, sectorCrop, splitRays } from './coverageCore';
import type { CoverageChunk, CoverageLine, CoverageResult } from './coverageCore';
import { coverageHeights } from './coverageStats';
import type { CoverageShown } from './coverageStats';
import { drawCoverage, clearCoverageView, redrawCoverage } from './coverageView';
// ?worker: Vite выбирает формат сам — модуль в dev, классический воркер в сборке (Chrome 68 не умеет module workers).
import CoverageWorker from './coverage.worker?worker';

// Воркеров на расчёт: ядро оставляем странице. Лучи делятся на части (по 3 на воркер — для выравнивания нагрузки),
// каждой части — вырезка мозаики под её сектор (≈ 1/8 площади), так что память почти не растёт с числом воркеров.
const POOL = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
const PARTS_PER_WORKER = 3;
const PRELIM_TILES = 16; // предварительный проход: грубый рельеф не больше стольких тайлов

/** Показанный результат (только чтение снаружи). */
export let shown: CoverageShown | null = null;
/** Входные данные менялись после расчёта показанного результата. */
export let stale = false;
/** Идёт расчёт. */
export let running = false;
/** Последний расчёт сорвался (dem — нет данных рельефа); сбрасывается новым расчётом и очисткой. */
export let lastError: { dem: boolean; text: string } | null = null;
let workers: Worker[] = [];
let runId = 0;
let inputsRev = 0; // растёт при каждом изменении пульта/радио — для проверки свежести результата
let notify: (() => void) | null = null;

/** Кого известить об изменении состояния (шторка и плашка зоны); null — никого. */
export function setCoverageListener(f: (() => void) | null): void {
  notify = f;
}

/** Входные данные расчёта изменились (пульт, радио, радиус, высоты): показанный результат устарел. */
export function markInputsChanged(): void {
  inputsRev++;
  if (shown) stale = true;
}

/** Радиопараметры расчёта без высоты дрона: событие 'radio' приходит и при смене одной только S.droneH. */
const radioSig = () => JSON.stringify([effRadio(), effVideoOrNull(), S.antenna]);

/** Подписка на смену пульта и радио. */
export function initCoverageRun(): void {
  let sig = radioSig();
  const markStale = () => {
    inputsRev++;
    if (!shown) return;
    stale = true;
    notify?.();
  };
  on('station', markStale);
  on('radio', () => {
    const now = radioSig();
    if (now !== sig) { sig = now; markStale(); return; }
    // Сменилась только высота дрона (или список сравнения): показываем её, если она посчитана.
    if (shown) redrawCoverage();
    notify?.();
  });
}

// Пул воркеров создаётся при расчёте и живёт между расчётами (запуск — десятки мс); после минуты простоя гасится.
const IDLE_MS = 60000;
let idleT = 0;
function ensurePool() {
  clearTimeout(idleT);
  while (workers.length < POOL) workers.push(new CoverageWorker());
}
function stopPool() {
  workers.forEach((w) => w.terminate());
  workers = [];
}
function idleLater() {
  clearTimeout(idleT);
  idleT = window.setTimeout(() => { if (!running) stopPool(); }, IDLE_MS);
}

export function cancelCoverage(): void {
  runId++;
  if (running) stopPool();
  running = false;
  progress(null);
}

export function clearCoverage(): void {
  cancelCoverage();
  shown = null;
  stale = false;
  lastError = null;
  clearCoverageView();
  notify?.();
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
function show(c: CoverageShown, rev: number) {
  shown = c;
  stale = rev !== inputsRev; // входные данные менялись во время расчёта
  drawCoverage(c);
  notify?.();
}

export async function startCoverage(): Promise<void> {
  if (running || !S.station) return;
  const st = { ...S.station };
  const center: LatLon = { lat: st.lat, lon: st.lon };
  const heights = coverageHeights(S.coverage.heights, S.droneH, S.coverage.compare);
  const radius = S.coverage.radius;
  const box = coverageBox(center, radius);
  // Круг через меридиан 180°: долготы «переворачиваются», и мозаика раздулась бы на весь мир.
  if (box.e < box.w || Math.abs(box.n) > 84 || Math.abs(box.s) > 84) {
    toast('Зона через меридиан 180° или у полюса пока не поддерживается');
    return;
  }
  const { z, step } = coverageZoom(center, radius);
  const pad = Math.ceil(step / demPixelM(center.lat, z)) + 2; // окно максимума выходит за радиус на step/2

  const id = ++runId;
  const rev = inputsRev;
  // Снимок радиопараметров до await: иначе старый пульт смешается с новыми настройками.
  const radio = { ...effRadio() }, mode = 'takeoff' as const; // копия: effRadio() может вернуть сам S.radio; высота — от взлёта (station.ts)
  const vRadio = S.video.enabled ? { ...effVideo() } : null;
  // Частота влияет на дифракцию, поэтому у видео свой прогон; обе линии считаются в одной части на одной вырезке.
  // Направленная антенна на земле: бюджет — с пиковым усилением (effRadio без азимута), по лучам — диаграмма.
  const aimOf = (line: 'rc' | 'video') => (directional(S.antenna[line]) ? { antenna: { ...S.antenna[line] }, heading: S.antenna.heading } : undefined);
  const lines: CoverageLine[] = [radio, ...(vRadio ? [vRadio] : [])].map((rp, i) => ({ freqMHz: rp.freqMHz, budget: budget(rp), k: rp.k, fade: rp.fadeMarginDb, aim: aimOf(i === 0 ? 'rc' : 'video') }));
  const rays = heights.length <= 2 ? 720 : 360;
  const base = { lat: center.lat, lon: center.lon, antH: st.antH, heights, mode, radius, step, rays, exact: false, lines };
  const mkShown = (r: CoverageResult[], stp: number, ry: number, prelim: boolean): CoverageShown => ({
    res: r[0], resV: r[1] ?? null, center, radius, step: stp, rays: ry, heights, fade: lines[0].fade, fadeV: lines[1]?.fade ?? 0, prelim,
  });
  running = true;
  lastError = null;
  progress(0, 'Загрузка рельефа…');
  notify?.();
  const corners = [
    { lat: box.n, lon: box.w }, { lat: box.n, lon: box.e },
    { lat: box.s, lon: box.e }, { lat: box.s, lon: box.w },
  ];
  // Предварительный проход (лучей ×¼, шаг ×2): на точном рельефе, если он уже в кеше, иначе — на грубом
  // (несколько тайлов, запрашиваются первыми), пока точный догружается. Без грубого (офлайн) — ждём точный.
  const stepP = step * 2, raysP = rays / 4;
  let zc = Math.max(8, z - 2);
  while (zc > 8 && demTileCount(corners, zc, 2) > PRELIM_TILES) zc--;
  const coarseP = zc < z ? fetchGrid(corners, zc, Math.ceil(stepP / demPixelM(center.lat, zc)) + 2) : null;
  let computing = false;
  let fineReady: DemGrid | null = null;
  const fineP = fetchGrid(corners, z, pad, (d, t) => { if (id === runId && !computing) progress(d / t, `Загрузка рельефа ${d}/${t}`); });
  fineP.then((g) => { fineReady = g; }, () => undefined); // ошибку разберём ниже, при ожидании
  try {
    const gP = await Promise.race(coarseP ? [fineP, coarseP.catch(() => fineP)] : [fineP]);
    if (id !== runId) return;
    // Точный рельеф уже есть (кеш, офлайн-район) — предварительный проход только отнял бы время.
    if (gP !== fineReady) {
      computing = true;
      progress(0, 'Предварительный расчёт…');
      const resP = await runPass(id, { ...base, step: stepP, rays: raysP }, gP, POOL);
      if (id !== runId) return;
      show(mkShown(resP, stepP, raysP, true), rev);
      computing = false;
    }
    const grid = await fineP;
    if (id !== runId) return;
    computing = true;
    progress(0, 'Расчёт…');
    const res = await runPass(id, base, grid, POOL * PARTS_PER_WORKER, (f) => progress(f, `Расчёт ${Math.round(f * 100)}%`));
    if (id !== runId) return;
    running = false; progress(null);
    idleLater();
    show(mkShown(res, step, rays, false), rev);
  } catch (err) {
    if (id !== runId) return;
    cancelCoverage();
    lastError = err instanceof DemMissingError
      ? { dem: true, text: 'Нет данных рельефа для этого района' }
      : { dem: false, text: `Ошибка расчёта: ${err instanceof Error ? err.message : err}` };
    if (notify) notify(); else toast(lastError.text, 4000);
  }
}
