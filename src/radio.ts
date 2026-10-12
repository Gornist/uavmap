// Радиорасчёт трассы: свободное пространство + дифракция на рельефе (ITU-R P.526, метод Дейгу),
// кривизна Земли с эквивалентным радиусом k·R, первая зона Френеля.
import { R_EARTH } from './geo';

export interface RadioParams {
  freqMHz: number;
  txPowerDbm: number;
  txGainDbi: number;
  rxGainDbi: number;
  sensDbm: number;     // чувствительность приёмника на нужном режиме
  lossDb: number;      // кабели, разъёмы, поляризация, корпус
  clutterDb: number;   // лес/застройка у точек (вручную)
  fadeMarginDb: number;// желаемый запас на замирания
  k: number;           // коэффициент рефракции (4/3 — стандартная атмосфера)
}

export interface RadioPreset { id: string; name: string; note: string; p: Partial<RadioParams> }

// Значения ориентировочные: подставьте паспортные данные своей аппаратуры.
export const PRESETS: RadioPreset[] = [
  { id: 'elrs24', name: 'ELRS 2.4 ГГц · 250 Гц', note: '100 мВт, диполи', p: { freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -108 } },
  { id: 'elrs24_50', name: 'ELRS 2.4 ГГц · 50 Гц', note: '250 мВт, дальний режим', p: { freqMHz: 2440, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -115 } },
  { id: 'elrs900', name: 'ELRS 868/915 МГц · 100 Гц', note: '250 мВт', p: { freqMHz: 868, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -117 } },
  { id: 'crsf', name: 'Crossfire 868 МГц · 50 Гц', note: '250 мВт', p: { freqMHz: 868, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -130 } },
  { id: 'lora433', name: 'LoRa 433 МГц · телеметрия', note: '100 мВт', p: { freqMHz: 433, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -125 } },
  { id: 'vtx58', name: 'Видео 5.8 ГГц аналог', note: '600 мВт, клевер/пэтч', p: { freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 8, sensDbm: -90 } },
  { id: 'vtx12', name: 'Видео 1.2 ГГц аналог', note: '800 мВт', p: { freqMHz: 1280, txPowerDbm: 29, txGainDbi: 2, rxGainDbi: 3, sensDbm: -90 } },
  { id: 'dig58', name: 'Цифровое видео 5.8 ГГц', note: '~700 мВт, типовой HD-линк', p: { freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 4, sensDbm: -94 } },
  { id: 'wifi24', name: 'Wi-Fi 2.4 ГГц (бытовой дрон)', note: '100 мВт', p: { freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -88 } },
];

export const DEFAULT_RADIO: RadioParams = {
  freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -108,
  lossDb: 2, clutterDb: 0, fadeMarginDb: 10, k: 4 / 3,
};

export const C = 299792458;

export function fspl(distM: number, fMHz: number): number {
  return 32.45 + 20 * Math.log10(Math.max(distM, 1) / 1000) + 20 * Math.log10(fMHz);
}

/** Потери на одиночном клиновидном препятствии, ITU-R P.526 (формула 31). */
export function knifeEdge(v: number): number {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Радиус первой зоны Френеля, м. */
export function fresnelR(d1: number, d2: number, lambda: number): number {
  return Math.sqrt((lambda * d1 * d2) / (d1 + d2));
}

/** Энергетический потенциал без учёта трассы: Pt + Gt + Gr − потери − чувствительность. */
export function budget(p: RadioParams): number {
  return p.txPowerDbm + p.txGainDbi + p.rxGainDbi - p.lossDb - p.clutterDb - p.sensDbm;
}

/** Дальность в свободном пространстве при заданном запасе. */
export function freeSpaceRange(p: RadioParams, margin = p.fadeMarginDb): number {
  const L = budget(p) - margin;
  return 1000 * 10 ** ((L - 32.45 - 20 * Math.log10(p.freqMHz)) / 20);
}

/** Дальность радиогоризонта (обе высоты над рельефом/уровнем), м. */
export function radioHorizon(h1: number, h2: number, k = 4 / 3): number {
  const Re = k * R_EARTH;
  return Math.sqrt(2 * Re * Math.max(h1, 0)) + Math.sqrt(2 * Re * Math.max(h2, 0));
}

export type LinkStatus = 'ok' | 'weak' | 'none';

export interface LinkResult {
  dist: number;
  fspl: number;
  diffraction: number;
  totalLoss: number;
  prx: number;
  margin: number;
  status: LinkStatus;
  los: boolean;                 // геометрическая прямая видимость
  minClearance: number;         // min (зазор / радиус Френеля); ≥0.6 — зона «чистая»
  fresnelBlocked: number;       // доля перекрытия первой зоны в худшей точке, 0..1+
  edges: number[];              // индексы препятствий, вошедших в расчёт дифракции
  // для графика
  d: Float64Array; ground: Float64Array; los_h: Float64Array; fz: Float64Array;
}

/**
 * elev — отметки рельефа с равным шагом от A до B (n+1 точек), dist — длина трассы, м.
 * hA, hB — абсолютные высоты антенн (над уровнем моря).
 */
export function analyzeLink(elev: ArrayLike<number>, dist: number, hA: number, hB: number, p: RadioParams): LinkResult {
  const n = elev.length - 1;
  const lambda = C / (p.freqMHz * 1e6);
  const Re = p.k * R_EARTH;
  const d = new Float64Array(n + 1), ground = new Float64Array(n + 1), losH = new Float64Array(n + 1), fz = new Float64Array(n + 1);
  let los = true, minClr = Infinity, worstBlock = 0;
  for (let i = 0; i <= n; i++) {
    d[i] = (dist * i) / n;
    // Рельеф «приподнят» на выпуклость Земли относительно хорды A–B.
    ground[i] = elev[i] + (d[i] * (dist - d[i])) / (2 * Re);
    losH[i] = hA + ((hB - hA) * d[i]) / dist;
    fz[i] = fresnelR(d[i], dist - d[i], lambda);
    if (i > 0 && i < n) {
      const clr = losH[i] - ground[i];
      if (clr < 0) los = false;
      if (fz[i] > 0) {
        minClr = Math.min(minClr, clr / fz[i]);
        worstBlock = Math.max(worstBlock, (fz[i] - clr) / (2 * fz[i]));
      }
    }
  }

  // Дейгу: главное препятствие, затем по одному на каждой половине (до 3 клиньев).
  const edges: number[] = [];
  const deygout = (a: number, b: number, depth: number): number => {
    if (b - a < 2) return 0;
    const da = d[a], db = d[b], ha = a === 0 ? hA : ground[a], hb = b === n ? hB : ground[b];
    let best = -Infinity, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d1 = d[i] - da, d2 = db - d[i];
      const h = ground[i] - (ha + ((hb - ha) * d1) / (db - da));
      const v = h * Math.sqrt((2 * (d1 + d2)) / (lambda * d1 * d2));
      if (v > best) { best = v; bi = i; }
    }
    if (bi < 0 || best <= -0.78) return 0;
    edges.push(bi);
    const L = knifeEdge(best);
    if (depth >= 1) return L;
    return L + deygout(a, bi, depth + 1) + deygout(bi, b, depth + 1);
  };
  const diffraction = n >= 2 ? deygout(0, n, 0) : 0;

  const fs = fspl(dist, p.freqMHz);
  const totalLoss = fs + diffraction;
  const prx = p.txPowerDbm + p.txGainDbi + p.rxGainDbi - p.lossDb - p.clutterDb - totalLoss;
  const margin = prx - p.sensDbm;
  const status: LinkStatus = margin >= p.fadeMarginDb ? 'ok' : margin >= 0 ? 'weak' : 'none';
  return {
    dist, fspl: fs, diffraction, totalLoss, prx, margin, status, los,
    minClearance: Number.isFinite(minClr) ? minClr : 1, fresnelBlocked: Math.max(0, worstBlock), edges,
    d, ground, los_h: losH, fz,
  };
}

/**
 * Минимальная высота дрона (м над точкой отсчёта), при которой запас ≥ требуемого.
 * heightFn(h) → абсолютная высота дрона для h. Возвращает null, если не хватает и на maxH.
 */
export function minHeightForLink(elev: ArrayLike<number>, dist: number, hA: number, heightFn: (h: number) => number, p: RadioParams, maxH = 1500): number | null {
  const ok = (h: number) => analyzeLink(elev, dist, hA, heightFn(h), p).margin >= p.fadeMarginDb;
  if (!ok(maxH)) return null;
  if (ok(0)) return 0;
  let lo = 0, hi = maxH;
  while (hi - lo > 2) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi);
}
