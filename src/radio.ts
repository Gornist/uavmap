// Радиорасчёт трассы: свободное пространство + дифракция на рельефе (ITU-R P.526-15 § 4.5, «дельта-Буллингтон»,
// см. diffraction.ts), кривизна Земли с эквивалентным радиусом k·R, первая зона Френеля.
import { R_EARTH } from './geo';
import { deltaBullington } from './diffraction';
import { aimAtElevation, elevationDeg, GroundAim } from './antenna';

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
  /** Направленная антенна на земле с вертикальной диаграммой (antenna.ts aimRadio): усиление — по углу места на дрон. */
  aim?: GroundAim;
}
/** Числовые поля радиопараметров (то, что задаёт пользователь и хранит проект; aim — только в расчёте). */
export type RadioNumKey = Exclude<keyof RadioParams, 'aim'>;

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

export function fspl(distM: number, fMHz: number): number {
  return 32.45 + 20 * Math.log10(Math.max(distM, 1) / 1000) + 20 * Math.log10(fMHz);
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
  /** Лес на трассе (withCanopy): м пути сквозь кроны и потери от леса, дБ (уже в totalLoss); null — лес не задан. */
  forest: { m: number; db: number } | null;
  /** Верх крон над хордой (как ground, с выпуклостью Земли); null — без леса. Для графика. */
  canopyTop: Float64Array | null;
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
  // Антенна на земле с наклоном / вертикальной диаграммой: усиление — для угла места на дрон на этой высоте и дальности.
  // Здесь, а не у вызывающих: нужная высота, высотомер, точки потери связи меняют hB и dist — поправка следует сама.
  if (p.aim) p = aimAtElevation(p, elevationDeg(hA, hB, dist, Re));
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
  const veg = forestLoss(elev, canopies.get(elev as object), dist, hA, hB, Re, p.freqMHz, lambda, diffraction, ground, losH, los);

  const fs = fspl(dist, p.freqMHz);
  const totalLoss = fs + diffraction + (veg ? veg.db : 0);
  const prx = p.txPowerDbm + p.txGainDbi + p.rxGainDbi - p.lossDb - p.clutterDb - totalLoss;
  // Антенна ниже рельефа в своей точке (дрон «в склоне» в режиме над взлётом) — связи нет.
  const belowGround = hA < elev[0] - 0.05 || hB < elev[n] - 0.05; // допуск на округление Float32
  const margin = belowGround ? Math.min(prx - p.sensDbm, -99) : prx - p.sensDbm;
  const status: LinkStatus = margin >= p.fadeMarginDb ? 'ok' : margin >= 0 ? 'weak' : 'none';
  return {
    dist, fspl: fs, diffraction, totalLoss, prx, margin, status, los: los && !belowGround, belowGround,
    minClearance: Number.isFinite(minClr) ? minClr : 1, fresnelBlocked: Math.max(0, worstBlock), edges,
    forest: veg ? { m: veg.m, db: veg.db } : null, canopyTop: veg ? veg.top : null,
    d, ground, los_h: losH, fz,
  };
}

// ---------- Лес на трассе (ITU-R P.833-10) ----------
// Полог задаётся отдельно от рельефа: высота крон над рельефом в каждом отсчёте (0 — не лес). Привязан к самому
// массиву отметок (withCanopy), поэтому доходит до всех расчётов по этой трассе — нужной высоты, высотомера, точек
// потери связи — без лишнего параметра в каждой функции.
const canopies = new WeakMap<object, ArrayLike<number>>();

/** Привязать полог (м над рельефом по отсчётам, той же длины) к профилю; null — без леса. Возвращает тот же профиль. */
export function withCanopy<T extends ArrayLike<number>>(elev: T, canopy: ArrayLike<number> | null): T {
  if (canopy && canopy.length === elev.length) canopies.set(elev as object, canopy); else canopies.delete(elev as object);
  return elev;
}
export const canopyOf = (elev: ArrayLike<number>): ArrayLike<number> | null => canopies.get(elev as object) ?? null;

/** Удельное затухание в кронах, дБ/м: ≈ 0,2·f[ГГц] (P.833-10, рис. 2; смешанный лес в листве). */
export const vegGamma = (fMHz: number) => 0.2 * (fMHz / 1000);
/** Предел затухания A_m = 1,37·f[МГц]^0,42, дБ (P.833-10, табл. 1: смешанный лес 12–16 м, Санкт-Петербург). */
export const vegLimit = (fMHz: number) => 1.37 * Math.pow(fMHz, 0.42);
/** Затухание на пути d м сквозь кроны с насыщением (P.833-10, § 2.1): A_m·(1 − e^(−d·γ/A_m)). */
export function vegLoss(dM: number, fMHz: number): number {
  if (dM <= 0) return 0;
  const am = vegLimit(fMHz);
  return am * (1 - Math.exp((-dM * vegGamma(fMHz)) / am));
}

/**
 * Потери от леса сверх дифракции на рельефе.
 * - Рельеф луч не закрывает: итог — по самому «лёгкому» пути (P.833-10, § 3): min(дифракция над кронами −
 *   дифракция над рельефом, затухание сквозь кроны). Путь сквозь кроны — отсчёты, где луч ниже верха крон, но выше
 *   рельефа. Концы трассы не приподнимаются: антенна в лесу «видит» кроны вокруг себя как путь сквозь них.
 * - Рельеф луч закрывает: волна огибает хребет — и лес на его гребне вместе с ним, прямого пути сквозь кроны нет;
 *   полог — часть препятствия (FOREST.md, § 2, п. 1): дифракция над кронами − над рельефом.
 */
function forestLoss(
  elev: ArrayLike<number>, canopy: ArrayLike<number> | undefined, dist: number, hA: number, hB: number, Re: number,
  fMHz: number, lambda: number, bare: number, ground: Float64Array, losH: Float64Array, bareLos: boolean,
): { m: number; db: number; top: Float64Array } | null {
  if (!canopy) return null;
  const n = elev.length - 1;
  const top = new Float64Array(n + 1), withTop = new Float64Array(n + 1);
  let any = false, inside = 0;
  for (let i = 0; i <= n; i++) {
    const c = i > 0 && i < n ? Math.max(0, canopy[i]) : 0;
    top[i] = ground[i] + c;
    withTop[i] = elev[i] + c;
    if (c > 0) {
      any = true;
      const clr = losH[i] - ground[i];
      if (clr >= 0 && clr < c) inside++;
    }
  }
  if (!any) return { m: 0, db: 0, top };
  const m = (inside * dist) / n;
  const over = deltaBullington(withTop, dist, hA, hB, Re, fMHz, lambda).loss - bare;
  return { m, db: Math.max(0, bareLos ? Math.min(over, vegLoss(m, fMHz)) : over), top };
}

/**
 * Минимальная высота дрона (м над точкой отсчёта), при которой запас ≥ требуемого.
 * heightFn(h) → абсолютная высота дрона для h. Возвращает null, если не хватает и на maxH
 * (с вертикальной диаграммой антенны на земле — ни на какой высоте до maxH, см. lowestOk).
 */
export function minHeightForLink(elev: ArrayLike<number>, dist: number, hA: number, heightFn: (h: number) => number, p: RadioParams, maxH = 1500): number | null {
  const ok = (h: number) => analyzeLink(elev, dist, hA, heightFn(h), p).margin >= p.fadeMarginDb;
  if (p.aim) return lowestOk(ok, 0, maxH, scanStep(p, dist));
  if (!ok(maxH)) return null;
  if (ok(0)) return 0;
  let lo = 0, hi = maxH;
  while (hi - lo > 2) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi);
}

/** Наибольший шаг перебора высот, когда запас не растёт с высотой монотонно (см. lowestOk), м. */
const SCAN_STEP = 25;

/**
 * Шаг перебора высот для линии p на трассе длиной dist: не больше четверти вертикальной ширины луча антенны
 * на земле в пересчёте на высоту у цели (dist·tan(θv/4); при угле места выше нуля тот же угол — ещё больше метров,
 * так что оценка с запасом), от 1 до SCAN_STEP м. Узкий луч на близкой цели — окно высот в несколько метров.
 */
function scanStep(p: RadioParams, dist: number): number {
  const bv = Math.min(180, p.aim?.antenna.beamVDeg ?? 180);
  return Math.max(1, Math.min(SCAN_STEP, dist * Math.tan((bv / 4) * (Math.PI / 180))));
}

/**
 * Наименьшая высота от from до maxH, где ok: перебор вверх с шагом step до первой удачной, затем деление
 * пополам до 2 м. Для антенны на земле с вертикальной диаграммой: выше — не всегда лучше (дрон уходит из луча
 * вверх), и проверка «хватит ли на maxH» дала бы ложное «не добьёт». Окно связи уже шага перебора (четверть
 * вертикального луча, см. scanStep) может быть пропущено — только если запас в нём едва дотягивает до желаемого.
 */
function lowestOk(ok: (h: number) => boolean, from: number, maxH: number, step: number): number | null {
  if (ok(from)) return from;
  let lo = from, hi = -1;
  for (let h = from + step; ; h += step) {
    const hh = Math.min(h, maxH);
    if (ok(hh)) { hi = hh; break; }
    lo = hh;
    if (hh >= maxH) return null;
  }
  while (hi - lo > 2) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi);
}

/**
 * Где по пути к цели пропадёт связь: дрон летит от пульта к цели на постоянной абсолютной высоте hB.
 * Возвращает расстояние от пульта (м) до первой точки, где связи нет (запас < 0 или дрон ниже склона),
 * или null — связь есть на всём пути. Перебор всех отсчётов: связь вдоль рельефа не монотонна (может пропасть
 * за бугром и вернуться), грубый шаг пропустил бы короткий провал. 200 отсчётов — около миллисекунды.
 */
export function lossAlong(elev: ArrayLike<number>, dist: number, hA: number, hB: number, p: RadioParams): number | null {
  const n = elev.length - 1;
  if (n < 2) return null;
  const cut = (a: ArrayLike<number>, k: number) => (a instanceof Float32Array || a instanceof Float64Array ? a.subarray(0, k + 1) : Array.prototype.slice.call(a, 0, k + 1));
  const can = canopyOf(elev);
  // Часть трассы — со своей частью полога (иначе лес потерялся бы на укороченной трассе).
  const sub = (k: number) => withCanopy(cut(elev, k), can ? cut(can, k) : null);
  const lost = (k: number) => {
    const r = analyzeLink(sub(k), (dist * k) / n, hA, hB, p);
    return r.belowGround || r.status === 'none';
  };
  for (let k = 2; k <= n; k++) if (lost(k)) return (dist * k) / n;
  return null;
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
function worstOf(rc: LinkResult, rcP: RadioParams, video: LinkResult | null, vP: RadioParams | null): LineId {
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
  // Вертикальная диаграмма антенны на земле: запас по высоте не монотонен — перебор от большей из двух высот.
  if (rc.aim || video.aim) {
    const pair = lowestOk(ok, Math.max(mRc, mV), maxH, Math.min(scanStep(rc, dist), scanStep(video, dist)));
    return { pair: pair === null ? null : Math.max(pair, mRc, mV), rc: mRc, video: mV };
  }
  let lo = Math.max(mRc, mV) - 1, hi = maxH;
  if (!ok(maxH)) return { pair: null, rc: mRc, video: mV };
  if (ok(Math.max(0, lo))) return { pair: Math.max(mRc, mV), rc: mRc, video: mV };
  lo = Math.max(0, lo);
  while (hi - lo > 2) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return { pair: Math.max(Math.ceil(hi), mRc, mV), rc: mRc, video: mV };
}

