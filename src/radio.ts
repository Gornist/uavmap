// Радиорасчёт трассы: свободное пространство + дифракция на рельефе (ITU-R P.526-15 § 4.5, «дельта-Буллингтон»,
// см. diffraction.ts), кривизна Земли с эквивалентным радиусом k·R, первая зона Френеля.
// Старый метод Дейгу оставлен как diffractionDeygout — для сравнения.
import { R_EARTH } from './geo';
import { deltaBullington, knifeEdgeJ } from './diffraction';

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

/** rc — управление; video — видео; telemetry — телеметрия/LoRa. both — один канал и для управления, и для видео (Wi-Fi). */
export type PresetKind = 'rc' | 'video' | 'telemetry';
export interface RadioPreset { id: string; name: string; note: string; kind: PresetKind; both?: boolean; p: Partial<RadioParams> }
/** Радиолиния: управление (rc) или видео. */
export type LineId = 'rc' | 'video';

// Значения ориентировочные: подставьте паспортные данные своей аппаратуры.
export const PRESETS: RadioPreset[] = [
  { id: 'elrs24', kind: 'rc', name: 'ELRS 2.4 ГГц · 250 Гц', note: '100 мВт, диполи', p: { freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -108 } },
  { id: 'elrs24_50', kind: 'rc', name: 'ELRS 2.4 ГГц · 50 Гц', note: '250 мВт, дальний режим', p: { freqMHz: 2440, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -115 } },
  { id: 'elrs900', kind: 'rc', name: 'ELRS 868/915 МГц · 100 Гц', note: '250 мВт (в ЕС на 868 — 25 мВт ERP)', p: { freqMHz: 868, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -117 } },
  { id: 'crsf', kind: 'rc', name: 'Crossfire 868 МГц · 50 Гц', note: '250 мВт (в ЕС лимит 25 мВт ERP)', p: { freqMHz: 868, txPowerDbm: 24, txGainDbi: 2, rxGainDbi: 2, sensDbm: -120 } },
  { id: 'lora433', kind: 'telemetry', name: 'LoRa 433 МГц · SF8/125 кГц', note: '100 мВт (в ЕС лимит 10 мВт ERP)', p: { freqMHz: 433, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -125 } },
  { id: 'vtx58', kind: 'video', name: 'Видео 5.8 ГГц аналог', note: '600 мВт, клевер/пэтч', p: { freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 8, sensDbm: -90 } },
  { id: 'vtx12', kind: 'video', name: 'Видео 1.2 ГГц аналог', note: '800 мВт', p: { freqMHz: 1280, txPowerDbm: 29, txGainDbi: 2, rxGainDbi: 3, sensDbm: -90 } },
  { id: 'dig58', kind: 'video', name: 'Цифровое видео 5.8 ГГц', note: '~700 мВт, типовой HD-линк', p: { freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 4, sensDbm: -94 } },
  { id: 'wifi24', kind: 'video', name: 'Wi-Fi 2.4 ГГц (бытовой дрон)', note: '100 мВт; один канал и для управления, и для видео — выберите его в обеих линиях', both: true, p: { freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -88 } },
];

export const DEFAULT_RADIO: RadioParams = {
  freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -108,
  lossDb: 4, clutterDb: 0, fadeMarginDb: 10, k: 4 / 3, // 4 дБ: кабели + поляризация + корпус
};

/** Видео по умолчанию: аналог 5.8 ГГц (пресет vtx58); потери и запас — как у управления. */
export const DEFAULT_VIDEO: RadioParams = {
  ...DEFAULT_RADIO, freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 8, sensDbm: -90,
};
export const DEFAULT_VIDEO_PRESET = 'vtx58';

/** Пресеты для линии: управление — rc, телеметрия и «общие» (Wi-Fi); видео — video. */
export const presetsFor = (line: LineId): RadioPreset[] =>
  PRESETS.filter((p) => (line === 'video' ? p.kind === 'video' : p.kind !== 'video' || p.both));

export const C = 299792458;

/** k < 0.5 физически бессмыслен и ломает расчёт (k ≤ 0 → NaN); очень большой k — плоская Земля. */
export const clampK = (k: number) => (Number.isFinite(k) ? Math.min(1e9, Math.max(0.5, k)) : 4 / 3);

/** Множитель вторичных клиньев Дейгу (ITU-R P.526): мал при слабом главном препятствии. */
export const deygoutT = (mainLoss: number) => 1 - Math.exp(-mainLoss / 6);

export function fspl(distM: number, fMHz: number): number {
  return 32.45 + 20 * Math.log10(Math.max(distM, 1) / 1000) + 20 * Math.log10(fMHz);
}

/** Потери на одиночном клиновидном препятствии, ITU-R P.526 (формула 31). */
export function knifeEdge(v: number): number {
  return knifeEdgeJ(v);
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
  const Re = clampK(k) * R_EARTH;
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
  belowGround: boolean;         // антенна А или Б ниже рельефа в своей точке
  minClearance: number;         // min (зазор / радиус Френеля); ≥0.6 — зона «чистая»
  fresnelBlocked: number;       // доля перекрытия первой зоны в худшей точке, 0..1+
  edges: number[];              // индексы точек Буллингтона: νmax (прямая видимость) или горизонты от A и от Б
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
  const Re = clampK(p.k) * R_EARTH;
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

  const db = deltaBullington(elev, dist, hA, hB, Re, p.freqMHz, lambda);
  const diffraction = db.loss, edges = db.edges;

  const fs = fspl(dist, p.freqMHz);
  const totalLoss = fs + diffraction;
  const prx = p.txPowerDbm + p.txGainDbi + p.rxGainDbi - p.lossDb - p.clutterDb - totalLoss;
  // Антенна ниже рельефа в своей точке (дрон «в склоне» в режиме над взлётом) — связи нет.
  const belowGround = hA < elev[0] - 0.05 || hB < elev[n] - 0.05; // допуск на округление Float32
  const margin = belowGround ? Math.min(prx - p.sensDbm, -99) : prx - p.sensDbm;
  const status: LinkStatus = margin >= p.fadeMarginDb ? 'ok' : margin >= 0 ? 'weak' : 'none';
  return {
    dist, fspl: fs, diffraction, totalLoss, prx, margin, status, los: los && !belowGround, belowGround,
    minClearance: Number.isFinite(minClr) ? minClr : 1, fresnelBlocked: Math.max(0, worstBlock), edges,
    d, ground, los_h: losH, fz,
  };
}

/**
 * Метод Дейгу (из ранних редакций ITU-R P.526; в P.526-15 его нет — заменён § 4.5): главный клин и по одному
 * на каждой половине, вторичные — с множителем T = 1 − exp(−Lp/6). Оставлен для сравнения с дельта-Буллингтоном.
 * Аргументы — как у analyzeLink. Возвращает потери, дБ, и индексы клиньев.
 */
export function diffractionDeygout(elev: ArrayLike<number>, dist: number, hA: number, hB: number, p: RadioParams): { loss: number; edges: number[] } {
  const n = elev.length - 1;
  const lambda = C / (p.freqMHz * 1e6);
  const Re = clampK(p.k) * R_EARTH;
  const d = new Float64Array(n + 1), ground = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    d[i] = (dist * i) / n;
    ground[i] = elev[i] + (d[i] * (dist - d[i])) / (2 * Re);
  }
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
    return L + deygoutT(L) * (deygout(a, bi, depth + 1) + deygout(bi, b, depth + 1));
  };
  return { loss: n >= 2 ? deygout(0, n, 0) : 0, edges };
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

// ---------- Две линии: управление и видео ----------

export interface PairResult {
  rc: LinkResult;
  video: LinkResult | null;
  worst: LineId;          // линия, ограничивающая связь (при равенстве — управление)
  status: LinkStatus;     // статус худшей линии
  score: number;          // запас худшей линии относительно её желаемого запаса, дБ (для ранжирования)
}

export const RANK: Record<LinkStatus, number> = { none: 0, weak: 1, ok: 2 };

/** Худшая из двух линий: сначала по статусу, при равных — по запасу сверх желаемого. */
export function worstOf(rc: LinkResult, rcP: RadioParams, video: LinkResult | null, vP: RadioParams | null): LineId {
  if (!video || !vP) return 'rc';
  if (RANK[video.status] !== RANK[rc.status]) return RANK[video.status] < RANK[rc.status] ? 'video' : 'rc';
  return video.margin - vP.fadeMarginDb < rc.margin - rcP.fadeMarginDb ? 'video' : 'rc';
}

/** Трасса для двух линий сразу (video = null — как раньше, одна линия). Геометрия общая, частоты разные. */
export function analyzePair(elev: ArrayLike<number>, dist: number, hA: number, hB: number, rc: RadioParams, video: RadioParams | null): PairResult {
  const r = analyzeLink(elev, dist, hA, hB, rc);
  const v = video ? analyzeLink(elev, dist, hA, hB, video) : null;
  const worst = worstOf(r, rc, v, video);
  const w = worst === 'video' && v && video ? { res: v, p: video } : { res: r, p: rc };
  return { rc: r, video: v, worst, status: w.res.status, score: w.res.margin - w.p.fadeMarginDb };
}

/**
 * Минимальная высота дрона, при которой связь держат ОБЕ линии (каждая — со своим желаемым запасом),
 * и по отдельности. null — не хватает и на maxH. pair ≥ max(rc, video) гарантировано.
 */
export function minHeightsForPair(elev: ArrayLike<number>, dist: number, hA: number, heightFn: (h: number) => number, rc: RadioParams, video: RadioParams | null, maxH = 1500): { pair: number | null; rc: number | null; video: number | null } {
  const mRc = minHeightForLink(elev, dist, hA, heightFn, rc, maxH);
  const mV = video ? minHeightForLink(elev, dist, hA, heightFn, video, maxH) : null;
  if (!video) return { pair: mRc, rc: mRc, video: null };
  if (mRc === null || mV === null) return { pair: null, rc: mRc, video: mV };
  const ok = (h: number) => {
    const b = heightFn(h);
    return analyzeLink(elev, dist, hA, b, rc).margin >= rc.fadeMarginDb && analyzeLink(elev, dist, hA, b, video).margin >= video.fadeMarginDb;
  };
  let lo = Math.max(mRc, mV) - 1, hi = maxH;
  if (!ok(maxH)) return { pair: null, rc: mRc, video: mV };
  if (ok(Math.max(0, lo))) return { pair: Math.max(mRc, mV), rc: mRc, video: mV };
  lo = Math.max(0, lo);
  while (hi - lo > 2) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return { pair: Math.max(Math.ceil(hi), mRc, mV), rc: mRc, video: mV };
}

/** Минимальная высота, при которой обе линии (или одна, если video = null) держат свой запас. */
export const minHeightForPair = (elev: ArrayLike<number>, dist: number, hA: number, heightFn: (h: number) => number, rc: RadioParams, video: RadioParams | null, maxH = 1500) =>
  minHeightsForPair(elev, dist, hA, heightFn, rc, video, maxH).pair;
