// Зона радиовидимости: радиальная развёртка от пульта по рельефу.
// Для каждой точки луча считается запас линии на каждой из заданных высот дрона:
// свободное пространство + дифракция на главном препятствии луча (P.526).
import { destination, lonLatToPixel, R_EARTH } from './geo';
import { DemGrid, sampleGrid } from './elevation';

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

function knifeEdge(v: number) {
  return v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

self.onmessage = (e: MessageEvent<CoverageJob>) => {
  const j = e.data;
  const nS = Math.floor(j.radius / j.step) + 1;
  const nH = j.heights.length;
  const lambda = 299792458 / (j.freqMHz * 1e6);
  const Re = j.k * R_EARTH;
  const fsConst = 32.45 + 20 * Math.log10(j.freqMHz);
  const margins = new Float32Array(nH * j.rays * nS);
  const firstLoss = new Float32Array(nH * j.rays);
  const g = new Float64Array(nS), dd = new Float64Array(nS);
  const maxV = new Float64Array(nH), rx = new Float64Array(nH);

  const [px0, py0] = lonLatToPixel(j.lon, j.lat, j.grid.z);
  const ground0 = sampleGrid(j.grid, px0, py0);
  const tx = ground0 + j.antH;

  for (let r = 0; r < j.rays; r++) {
    const az = (360 * r) / j.rays;
    for (let s = 0; s < nS; s++) {
      dd[s] = s * j.step;
      if (s === 0) { g[s] = ground0; continue; }
      const p = destination({ lat: j.lat, lon: j.lon }, az, dd[s]);
      const [x, y] = lonLatToPixel(p.lon, p.lat, j.grid.z);
      g[s] = sampleGrid(j.grid, x, y);
    }
    for (let h = 0; h < nH; h++) firstLoss[h * j.rays + r] = j.radius;
    const lost = new Uint8Array(nH);

    for (let s = 1; s < nS; s++) {
      const D = dd[s];
      for (let h = 0; h < nH; h++) {
        rx[h] = (j.mode === 'takeoff' ? ground0 : g[s]) + j.heights[h];
        maxV[h] = -Infinity;
      }
      for (let i = 1; i < s; i++) {
        const d1 = dd[i], d2 = D - d1;
        const eff = g[i] + (d1 * d2) / (2 * Re);
        const f = Math.sqrt((2 * D) / (lambda * d1 * d2));
        const t = d1 / D;
        for (let h = 0; h < nH; h++) {
          const v = (eff - (tx + (rx[h] - tx) * t)) * f;
          if (v > maxV[h]) maxV[h] = v;
        }
      }
      const fs = fsConst + 20 * Math.log10(D / 1000);
      for (let h = 0; h < nH; h++) {
        const m = j.budget - fs - (s > 1 ? knifeEdge(maxV[h]) : 0);
        margins[(h * j.rays + r) * nS + s] = m;
        if (!lost[h] && m < j.fade) { lost[h] = 1; firstLoss[h * j.rays + r] = dd[s - 1]; }
      }
    }
    for (let h = 0; h < nH; h++) margins[(h * j.rays + r) * nS] = 99;
    if (r % 16 === 0) (self as unknown as Worker).postMessage({ progress: r / j.rays });
  }
  const res: CoverageResult = { margins, firstLoss, samples: nS, ground0 };
  (self as unknown as Worker).postMessage({ done: res }, [margins.buffer, firstLoss.buffer]);
};
