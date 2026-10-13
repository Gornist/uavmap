// Ядро расчёта зоны радиовидимости (чистая функция, тестируется без воркера): радиальная развёртка от пульта по рельефу.
// Для каждой точки луча считается запас линии на каждой из заданных высот дрона:
// свободное пространство + дифракция «дельта-Буллингтон» (ITU-R P.526-15 § 4.5.2, см. diffraction.ts) —
// та же модель, что в analyzeLink для профиля 0..s, но с инкрементальными величинами:
//  • Stim (49) и αobt (61b) не зависят от высоты дрона — накопительные максимумы по профилю;
//  • суммы регрессии гладкой Земли v1, v2 (58), (59) — накопительные суммы, O(1) на отсчёт;
//  • Буллингтон по гладкому профилю — O(log s) (bullingtonSmooth), сферическая Земля — O(1);
//  • по профилю 0..s проходим один раз на отсчёт для всех высот: νmax (51) или Srim (53), hobs и αobr (61).
// Ускорения (результат прежний):
//  • дрон ниже рельефа в своей точке → −99 сразу, без прохода по профилю;
//  • 1/√d, 1/d — таблицы по номеру отсчёта (шаг равномерный), без sqrt/делений во внутреннем цикле;
//  • exact = false (режим карты): где запас ЗАВЕДОМО < min(0, fade) — уровень «нет связи» при любой
//    дифракции, — пишется верхняя оценка запаса вместо точного значения (классификация и firstLoss те же):
//    дальше дальности свободного пространства; по главному препятствию прошлого отсчёта (оценка Lba снизу);
//    по самому Lba (хвост (64)–(66) только добавляет потери).
//  • r0..r1 — часть лучей (для параллельных воркеров), сетка может быть вырезкой мозаики под сектор.
import { destination, lonLatToPixel, R_EARTH } from './geo';
import { DemGrid, sampleGrid, sampleRay } from './elevation';
import { C, clampK } from './radio';
import { bullingtonPointNu, bullingtonTaper, deltaBullingtonTail, knifeEdgeJ, smoothSurfaceHeights } from './diffraction';

export interface CoverageJob {
  grid: DemGrid;
  lat: number; lon: number;
  antH: number;              // антенна пульта над землёй, м
  heights: number[];         // высоты дрона, м
  mode: 'takeoff' | 'terrain';
  radius: number; step: number; rays: number;
  freqMHz: number; budget: number; k: number; fade: number;
  r0?: number; r1?: number;  // считать лучи r0..r1−1 (по умолчанию все)
  exact?: boolean;           // false — заведомо «нет связи» без точного запаса (см. выше); по умолчанию true
}

export interface CoverageResult {
  margins: Float32Array;     // [(h * nr + (r − r0)) * samples + s], nr = r1 − r0 (для всех лучей — rays)
  firstLoss: Float32Array;   // [h * nr + (r − r0)] — расстояние до первого провала ниже запаса, м
  samples: number;
  ground0: number;
}

/** Порог, ниже которого уровень «нет связи» при любом fade: lvl = m ≥ fade ? 2 : m ≥ 0 ? 1 : 0. */
export const lossThreshold = (fade: number) => Math.min(0, fade);

const BS = 16; // блок промежуточных точек для отсечения по границам в (51)

/** Добавить точку (i, y[i]) в верхнюю оболочку (x возрастает); возвращает новую длину. */
function pushHull(hull: Int32Array, n: number, y: Float64Array, i: number): number {
  while (n >= 2) {
    const a = hull[n - 2], b = hull[n - 1];
    // b не выше отрезка a–i → не вершина верхней оболочки
    if ((b - a) * (y[i] - y[a]) - (y[b] - y[a]) * (i - a) >= 0) n--; else break;
  }
  hull[n] = i;
  return n + 1;
}

export function computeCoverage(j: CoverageJob, onProgress?: (frac: number) => void): CoverageResult {
  const nS = Math.floor(j.radius / j.step) + 1;
  const nH = j.heights.length;
  const r0 = j.r0 ?? 0, r1 = j.r1 ?? j.rays, nr = r1 - r0;
  const exact = j.exact !== false;
  const thr = lossThreshold(j.fade);
  const lambda = C / (j.freqMHz * 1e6);
  const ae = clampK(j.k) * R_EARTH;
  const k2 = 1 / (2 * ae);
  const fsConst = 32.45 + 20 * Math.log10(j.freqMHz);
  const margins = new Float32Array(nH * nr * nS);
  const firstLoss = new Float32Array(nH * nr);
  const g = new Float64Array(nS), gp = new Float64Array(nS), dd = new Float64Array(nS), G = new Float64Array(nS);
  const H = new Float64Array(nS);               // H_i = G_i − i²·cK (не зависит от D)
  const hullG = new Int32Array(nS), hullH = new Int32Array(nS); // верхние оболочки точек (i, G_i) и (i, H_i)
  const bmax = new Float64Array(Math.ceil(nS / BS) + 1);       // max H_i по блокам i ∈ [1 + b·BS, (b+1)·BS]
  const lost = new Uint8Array(nH);
  const arg = new Int32Array(nH);               // где был νmax на прошлом отсчёте — начальное значение для отсечения
  // Таблицы по номеру отсчёта: d_k = k·step.
  const isq = new Float64Array(nS), invd = new Float64Array(nS), fsl = new Float64Array(nS);
  for (let k = 1; k < nS; k++) {
    dd[k] = k * j.step;
    isq[k] = 1 / Math.sqrt(dd[k]);
    invd[k] = 1 / dd[k];
    fsl[k] = fsConst + 20 * Math.log10(dd[k] / 1000);
  }
  const cK = j.step * j.step * k2;              // d1·d2/(2ae) = i·(s−i)·cK
  const fK = 2 / lambda;

  const [px0, py0] = lonLatToPixel(j.lon, j.lat, j.grid.z);
  const ground0 = sampleGrid(j.grid, px0, py0);
  const tx = ground0 + j.antH;
  // Дальше sFree запас < thr уже в свободном пространстве (дифракция только добавляет потери).
  let sFree = nS;
  if (!exact) for (let s = 1; s < nS; s++) if (j.budget - fsl[s] < thr) { sFree = s; break; }

  for (let r = r0; r < r1; r++) {
    const ro = r - r0;
    const az = (360 * r) / j.rays;
    // Рельеф луча: максимум узлов DEM в окне ±step/2 (вершины хребтов не сглаживаются), g[0] — точка пульта.
    sampleRay(j.grid, j.lat, j.lon, az, j.step, nS, g);
    g[0] = ground0;
    // Высота в самой точке дрона (как конец профиля в analyzeLink) — для позиции дрона, регрессии и «ниже рельефа».
    gp[0] = ground0;
    for (let s = 1; s < nS; s++) {
      const p = destination({ lat: j.lat, lon: j.lon }, az, dd[s]);
      const [x, y] = lonLatToPixel(p.lon, p.lat, j.grid.z);
      gp[s] = sampleGrid(j.grid, x, y);
    }
    for (let s = 0; s < nS; s++) { G[s] = g[s] - tx; H[s] = G[s] - s * s * cK; }
    let nG = 0, nHh = 0;
    for (let h = 0; h < nH; h++) { firstLoss[h * nr + ro] = j.radius; lost[h] = 0; arg[h] = 0; }
    // Накопительные величины по промежуточным точкам 1..s−1 (не зависят от высоты дрона и от D):
    let stimB = -Infinity;  // max[(g_i − tx)/d_i − d_i/(2ae)]; Stim(D) = stimB + D/(2ae)   (49)
    let aobtB = -Infinity;  // max[(g_i − tx)/d_i];             αobt = aobtB − (rx − tx)/D   (61b)
    let v1 = 0, v2 = 0, v1a = 0, v2a = 0;   // (58), (59) по отрезкам 0..s−1 (все точки — промежуточные)

    for (let s = 1; s < nS; s++) {
      const D = dd[s];
      const fsm = j.budget - fsl[s];           // запас в свободном пространстве
      if (s >= sFree) {
        // Заведомо «нет связи» до конца луча: верхняя оценка запаса.
        for (let h = 0; h < nH; h++) {
          const o = (h * nr + ro) * nS;
          for (let q = s; q < nS; q++) margins[o + q] = j.budget - fsl[q];
          if (!lost[h]) { lost[h] = 1; firstLoss[h * nr + ro] = dd[s - 1]; }
        }
        break;
      }
      {
        const dl = D - dd[s - 1];
        // Последний отрезок — с высотой в точке дрона; в накопитель — с максимумом окна (станет промежуточной).
        v1 = v1a + dl * (gp[s] + g[s - 1]);
        v2 = v2a + dl * (gp[s] * (2 * D + dd[s - 1]) + g[s - 1] * (D + 2 * dd[s - 1]));
        v1a += dl * (g[s] + g[s - 1]);
        v2a += dl * (g[s] * (2 * D + dd[s - 1]) + g[s - 1] * (D + 2 * dd[s - 1]));
        if (s >= 2) {
          const i = s - 1, gi = G[i] / dd[i];
          if (gi - dd[i] * k2 > stimB) stimB = gi - dd[i] * k2;
          if (gi > aobtB) aobtB = gi;
          // Точка i становится промежуточной: верхние оболочки и максимум блока.
          nG = pushHull(hullG, nG, G, i);
          nHh = pushHull(hullH, nHh, H, i);
          const bk = ((i - 1) / BS) | 0;
          if (i === 1 + bk * BS || H[i] > bmax[bk]) bmax[bk] = H[i];
        }
      }
      const stim = stimB + D * k2;
      const invS = 1 / s;
      const fD = Math.sqrt(fK * D);
      const nb = s >= 2 ? (((s - 2) / BS) | 0) + 1 : 0;   // блоков промежуточных точек 1..s−1
      for (let h = 0; h < nH; h++) {
        const o = (h * nr + ro) * nS + s;
        const rxh = (j.mode === 'takeoff' ? ground0 : gp[s]) + j.heights[h]; // отрицательный рельеф не обрезаем, см. droneAbs
        // Дрон ниже рельефа в своей точке (режим над взлётом, склон выше взлёта) — связи нет.
        if (rxh < gp[s] - 0.05) { margins[o] = -99; markLost(h, s, ro); continue; }
        const dh = rxh - tx;
        const los = stim < dh / D;                                      // (50): Stim < Str → случай 1
        let best = -Infinity;                                           // νmax (51) или Srim (53)
        if (los) {
          // (51) ν_i = (hob_i + c_i)·f_i = (H_i + μ·i)·√(2D/λ)/√(d1·d2) — ветви и границы по блокам:
          // числитель ≤ max H в блоке + μ·(край), 1/√(d1·d2) — экстремумы на краях блока или в середине трассы.
          const mu = s * cK - dh * invS;
          let ia = arg[h];
          if (ia > 0 && ia < s) best = nuAt(ia, s, dh, invS, fD);
          else ia = 0;
          for (let bk = 0; bk < nb; bk++) {
            const i0 = 1 + bk * BS, i1 = Math.min(i0 + BS - 1, s - 1);
            const nmax = bmax[bk] + (mu >= 0 ? mu * i1 : mu * i0);
            let w: number;
            if (nmax >= 0) w = Math.max(isq[i0] * isq[s - i0], isq[i1] * isq[s - i1]);
            else w = 2 * i0 <= s && s <= 2 * i1 ? 2 / D : Math.min(isq[i0] * isq[s - i0], isq[i1] * isq[s - i1]);
            const bound = fD * nmax * w;
            if (!(bound + 1e-9 * Math.abs(bound) + 1e-12 > best)) continue;
            for (let i = i0; i <= i1; i++) {
              const q = nuAt(i, s, dh, invS, fD);
              if (q > best) { best = q; ia = i; }
            }
          }
          arg[h] = ia;
        } else {
          // (53) Srim = (G_i + c_i − dh)/d2_i: максимум — в вершине верхней оболочки точек (i, G_i − i²·cK).
          for (let k = 0; k < nHh; k++) {
            const i = hullH[k], si = s - i;
            const q = (G[i] + i * si * cK - dh) * invd[si];
            if (q > best) best = q;
          }
        }
        let luc: number;
        if (los) luc = knifeEdgeJ(best);                                                 // (52)
        else {
          const vb = bullingtonPointNu(stim, best, tx, rxh, D, lambda);                  // (54), (55)
          luc = knifeEdgeJ(vb ?? losNu(s, D, tx, rxh));                                  // (56)
        }
        const lba = bullingtonTaper(luc, D);                                             // (57)
        let m = fsm - lba;                                                               // верхняя оценка
        if (exact || m >= thr) {
          // (61a), (61c): максимумы hob и hob/d2 — тоже в вершинах верхней оболочки точек (i, G_i).
          let hobs = -Infinity, aobr = -Infinity;
          for (let k = 0; k < nG; k++) {
            const i = hullG[k];
            const hob = G[i] - dh * (i * invS);                // (61d): превышение над прямой A–Б (плоская Земля)
            if (hob > hobs) hobs = hob;
            const ar = hob * invd[s - i];
            if (ar > aobr) aobr = ar;
          }
          const [hst, hsr] = smoothSurfaceHeights(v1, v2, D, hobs, aobtB - dh / D, aobr, ground0, gp[s]);
          m = fsm - deltaBullingtonTail(lba, tx, rxh, hst, hsr, s, D, ae, j.freqMHz, lambda).loss; // (64)–(66)
        }
        margins[o] = m;
        if (m < j.fade) markLost(h, s, ro);
      }
    }
    for (let h = 0; h < nH; h++) margins[(h * nr + ro) * nS] = 99;
    if (onProgress && ro % 16 === 0) onProgress(ro / nr);
  }
  return { margins, firstLoss, samples: nS, ground0 };

  /** ν по (51) в промежуточной точке i. */
  function nuAt(i: number, s: number, dh: number, invS: number, fD: number): number {
    const si = s - i;
    return (G[i] - dh * (i * invS) + i * si * cK) * fD * isq[i] * isq[si];
  }

  function markLost(h: number, s: number, ro: number) {
    if (!lost[h]) { lost[h] = 1; firstLoss[h * nr + ro] = dd[s - 1]; }
  }

  /** νmax по (51) — запасной путь при вырожденной точке Буллингтона (касание линии A–Б), как в bullington(). */
  function losNu(s: number, D: number, hts: number, hrs: number): number {
    let v = -Infinity;
    for (let i = 1; i < s; i++) {
      const d1 = dd[i], d2 = D - d1;
      const x = (g[i] + d1 * d2 * k2 - (hts * d2 + hrs * d1) / D) * Math.sqrt((2 * D) / (lambda * d1 * d2));
      if (x > v) v = x;
    }
    return v;
  }
}

// ---------- Параллельный расчёт: части лучей в разных воркерах ----------

/** Радиопараметры одной линии (управление / видео) — частота влияет на дифракцию, поэтому прогоны раздельные. */
export interface CoverageLine { freqMHz: number; budget: number; k: number; fade: number }

/** Часть зоны: лучи r0..r1−1 для всех линий на одной (вырезанной под сектор) сетке. */
export interface CoverageChunk extends Omit<CoverageJob, 'freqMHz' | 'budget' | 'k' | 'fade'> {
  r0: number; r1: number;
  lines: CoverageLine[];
}

export function computeChunk(c: CoverageChunk, onProgress?: (frac: number) => void): CoverageResult[] {
  const { lines, ...base } = c;
  return lines.map((ln, li) => computeCoverage({ ...base, ...ln },
    onProgress && ((f) => onProgress((li + f) / lines.length))));
}

/**
 * Вырезка мозаики под сектор лучей r0..r1−1 (концы включительно): всё, что читают sampleRay и sampleGrid,
 * — с запасом в 3 узла. Координаты узлов в вырезке сдвигаются на целое число, поэтому выборка та же.
 */
export function sectorCrop(g: DemGrid, lat: number, lon: number, rays: number, r0: number, r1: number, radius: number, step: number): DemGrid {
  const nS = Math.floor(radius / step) + 1;
  const reach = (nS + 0.5) * step;                         // дальше последнего окна (nS − 0.5)·step
  const [cx, cy] = lonLatToPixel(lon, lat, g.z);
  let x0 = cx, x1 = cx, y0 = cy, y1 = cy;
  const a0 = (360 * r0) / rays, a1 = (360 * (r1 - 1)) / rays;
  const n = Math.max(1, Math.ceil(a1 - a0));               // дуга через ≤ 1°: прогиб хорды < 1 узла
  for (let k = 0; k <= n; k++) {
    const p = destination({ lat, lon }, a0 + ((a1 - a0) * k) / n, reach);
    const [x, y] = lonLatToPixel(p.lon, p.lat, g.z);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const ix0 = Math.max(0, Math.floor(x0 - g.px0) - 3), ix1 = Math.min(g.width - 1, Math.ceil(x1 - g.px0) + 3);
  const iy0 = Math.max(0, Math.floor(y0 - g.py0) - 3), iy1 = Math.min(g.height - 1, Math.ceil(y1 - g.py0) + 3);
  const w = ix1 - ix0 + 1, h = iy1 - iy0 + 1;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) data.set(g.data.subarray((iy0 + y) * g.width + ix0, (iy0 + y) * g.width + ix0 + w), y * w);
  return { z: g.z, px0: g.px0 + ix0, py0: g.py0 + iy0, width: w, height: h, data };
}

/** Деление лучей на n непрерывных частей (не больше rays). */
export function splitRays(rays: number, n: number): [number, number][] {
  const k = Math.max(1, Math.min(rays, n)), out: [number, number][] = [];
  for (let i = 0; i < k; i++) out.push([Math.floor((rays * i) / k), Math.floor((rays * (i + 1)) / k)]);
  return out;
}

/** Пустой результат на все лучи — части вписываются в него mergeChunk. */
export function emptyResult(nH: number, rays: number, samples: number): CoverageResult {
  return { margins: new Float32Array(nH * rays * samples), firstLoss: new Float32Array(nH * rays), samples, ground0: 0 };
}

/** Вписать результат части (лучи r0..r1−1) в полный. */
export function mergeChunk(full: CoverageResult, part: CoverageResult, nH: number, rays: number, r0: number, r1: number): void {
  const nr = r1 - r0, S = full.samples;
  for (let h = 0; h < nH; h++) {
    full.margins.set(part.margins.subarray(h * nr * S, (h + 1) * nr * S), (h * rays + r0) * S);
    full.firstLoss.set(part.firstLoss.subarray(h * nr, (h + 1) * nr), h * rays + r0);
  }
  full.ground0 = part.ground0;
}
