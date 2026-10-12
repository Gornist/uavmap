// Ядро расчёта зоны радиовидимости (чистая функция, тестируется без воркера): радиальная развёртка от пульта по рельефу.
// Для каждой точки луча считается запас линии на каждой из заданных высот дрона:
// свободное пространство + дифракция «дельта-Буллингтон» (ITU-R P.526-15 § 4.5.2, см. diffraction.ts) —
// та же модель, что в analyzeLink для профиля 0..s, но с инкрементальными величинами:
//  • Stim (49) и αobt (61b) не зависят от высоты дрона — накопительные максимумы по профилю;
//  • суммы регрессии гладкой Земли v1, v2 (58), (59) — накопительные суммы, O(1) на отсчёт;
//  • Буллингтон по гладкому профилю — O(log s) (bullingtonSmooth), сферическая Земля — O(1);
//  • по профилю 0..s проходим один раз на отсчёт для всех высот: νmax (51) или Srim (53), hobs и αobr (61).
import { destination, lonLatToPixel, R_EARTH } from './geo';
import { DemGrid, sampleGrid, sampleRay } from './elevation';
import { clampK } from './radio';
import { bullingtonPointNu, bullingtonTaper, deltaBullingtonTail, knifeEdgeJ, smoothSurfaceHeights } from './diffraction';

export interface CoverageJob {
  grid: DemGrid;
  lat: number; lon: number;
  antH: number;              // антенна пульта над землёй, м
  heights: number[];         // высоты дрона, м
  mode: 'takeoff' | 'terrain';
  radius: number; step: number; rays: number;
  freqMHz: number; budget: number; k: number; fade: number;
}

export interface CoverageResult {
  margins: Float32Array;     // [(h * rays + r) * samples + s]
  firstLoss: Float32Array;   // [h * rays + r] — расстояние до первого провала ниже запаса, м
  samples: number;
  ground0: number;
}

export function computeCoverage(j: CoverageJob, onProgress?: (frac: number) => void): CoverageResult {
  const nS = Math.floor(j.radius / j.step) + 1;
  const nH = j.heights.length;
  const lambda = 299792458 / (j.freqMHz * 1e6);
  const ae = clampK(j.k) * R_EARTH;
  const k2 = 1 / (2 * ae);
  const fsConst = 32.45 + 20 * Math.log10(j.freqMHz);
  const margins = new Float32Array(nH * j.rays * nS);
  const firstLoss = new Float32Array(nH * j.rays);
  const g = new Float64Array(nS), gp = new Float64Array(nS), dd = new Float64Array(nS);
  const rx = new Float64Array(nH), dh = new Float64Array(nH);
  const best = new Float64Array(nH);            // νmax (случай 1) или Srim без поправки (случай 2)
  const hobs = new Float64Array(nH), aobrB = new Float64Array(nH);
  const losCase = new Uint8Array(nH);

  const [px0, py0] = lonLatToPixel(j.lon, j.lat, j.grid.z);
  const ground0 = sampleGrid(j.grid, px0, py0);
  const tx = ground0 + j.antH;

  for (let r = 0; r < j.rays; r++) {
    const az = (360 * r) / j.rays;
    // Рельеф луча: максимум узлов DEM в окне ±step/2 (вершины хребтов не сглаживаются), g[0] — точка пульта.
    sampleRay(j.grid, j.lat, j.lon, az, j.step, nS, g);
    g[0] = ground0;
    // Высота в самой точке дрона (как конец профиля в analyzeLink) — для позиции дрона, регрессии и «ниже рельефа».
    gp[0] = ground0;
    for (let s = 0; s < nS; s++) {
      dd[s] = s * j.step;
      if (s === 0) continue;
      const p = destination({ lat: j.lat, lon: j.lon }, az, dd[s]);
      const [x, y] = lonLatToPixel(p.lon, p.lat, j.grid.z);
      gp[s] = sampleGrid(j.grid, x, y);
    }
    for (let h = 0; h < nH; h++) firstLoss[h * j.rays + r] = j.radius;
    const lost = new Uint8Array(nH);
    // Накопительные величины по промежуточным точкам 1..s−1 (не зависят от высоты дрона и от D):
    let stimB = -Infinity;  // max[(g_i − tx)/d_i − d_i/(2ae)]; Stim(D) = stimB + D/(2ae)   (49)
    let aobtB = -Infinity;  // max[(g_i − tx)/d_i];             αobt = aobtB − (rx − tx)/D   (61b)
    let v1 = 0, v2 = 0, v1a = 0, v2a = 0;   // (58), (59) по отрезкам 0..s−1 (все точки — промежуточные)

    for (let s = 1; s < nS; s++) {
      const D = dd[s];
      {
        const dl = D - dd[s - 1];
        // Последний отрезок — с высотой в точке дрона; в накопитель — с максимумом окна (станет промежуточной).
        v1 = v1a + dl * (gp[s] + g[s - 1]);
        v2 = v2a + dl * (gp[s] * (2 * D + dd[s - 1]) + g[s - 1] * (D + 2 * dd[s - 1]));
        v1a += dl * (g[s] + g[s - 1]);
        v2a += dl * (g[s] * (2 * D + dd[s - 1]) + g[s - 1] * (D + 2 * dd[s - 1]));
        if (s >= 2) {
          const i = s - 1, gi = (g[i] - tx) / dd[i];
          if (gi - dd[i] * k2 > stimB) stimB = gi - dd[i] * k2;
          if (gi > aobtB) aobtB = gi;
        }
      }
      const stim = stimB + D * k2;
      for (let h = 0; h < nH; h++) {
        rx[h] = (j.mode === 'takeoff' ? ground0 : gp[s]) + j.heights[h]; // отрицательный рельеф не обрезаем, см. droneAbs
        dh[h] = rx[h] - tx;
        losCase[h] = stim < dh[h] / D ? 1 : 0;                           // (50): Stim < Str → случай 1
        best[h] = -Infinity; hobs[h] = -Infinity; aobrB[h] = -Infinity;
      }
      for (let i = 1; i < s; i++) {
        const d1 = dd[i], d2 = D - d1;
        const c = d1 * d2 * k2;                      // выпуклость Земли
        const G = g[i] - tx, t = d1 / D, inv = 1 / d2;
        const f = Math.sqrt((2 * D) / (lambda * d1 * d2));
        for (let h = 0; h < nH; h++) {
          const hob = G - dh[h] * t;                 // (61d): превышение над прямой A–Б (плоская Земля)
          if (hob > hobs[h]) hobs[h] = hob;          // (61a)
          const ar = hob * inv;
          if (ar > aobrB[h]) aobrB[h] = ar;          // (61c)
          // (51): ν = (hob + c)·f;  (53): Srim = (G + c − dh)/d2
          const q = losCase[h] ? (hob + c) * f : (G + c - dh[h]) * inv;
          if (q > best[h]) best[h] = q;
        }
      }
      const fs = fsConst + 20 * Math.log10(D / 1000);
      for (let h = 0; h < nH; h++) {
        let luc: number;
        if (losCase[h]) luc = knifeEdgeJ(best[h]);                                       // (52)
        else {
          const vb = bullingtonPointNu(stim, best[h], tx, rx[h], D, lambda);             // (54), (55)
          luc = knifeEdgeJ(vb ?? losNu(s, D, tx, rx[h]));                                // (56)
        }
        const lba = bullingtonTaper(luc, D);                                             // (57)
        const [hst, hsr] = smoothSurfaceHeights(v1, v2, D, hobs[h], aobtB - dh[h] / D, aobrB[h], ground0, gp[s]);
        const diff = deltaBullingtonTail(lba, tx, rx[h], hst, hsr, s, D, ae, j.freqMHz, lambda).loss; // (64)–(66)
        // Дрон ниже рельефа в своей точке (режим над взлётом, склон выше взлёта) — связи нет.
        const m = rx[h] < gp[s] - 0.05 ? -99 : j.budget - fs - diff;
        margins[(h * j.rays + r) * nS + s] = m;
        if (!lost[h] && m < j.fade) { lost[h] = 1; firstLoss[h * j.rays + r] = dd[s - 1]; }
      }
    }
    for (let h = 0; h < nH; h++) margins[(h * j.rays + r) * nS] = 99;
    if (onProgress && r % 16 === 0) onProgress(r / j.rays);
  }
  return { margins, firstLoss, samples: nS, ground0 };

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
