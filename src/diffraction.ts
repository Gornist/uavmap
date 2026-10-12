// Дифракция на трассе по методу «дельта-Буллингтон» — ITU-R P.526-15, § 4.5 («Method for a general
// terrestrial path»): § 4.5.1 — модель Буллингтона, § 4.5.2 — полный метод (Буллингтон по реальному
// профилю + поправка «сферическая Земля − Буллингтон по гладкому профилю»), § 3.2 / § 3.1.1 — дифракция
// над сферической Землёй. Тот же алгоритм — ITU-R P.1812-6 § 4.3 и P.452-17 § 4.2 (dl_bull, dl_se,
// dl_delta_bull в эталонной реализации Py1812). Номера уравнений ниже — по P.526-15.
//
// Единицы: всё в метрах (расстояния, высоты, радиус Земли ae), длина волны λ в метрах. Формулы стандарта
// в «практических единицах» (км, м/км, 500·Ce·di·(d−di), 0.002·d/(λ·di·(d−di))) переписаны в метрах:
// 500·Ce·di·(d−di) [км] ≡ di·(d−di)/(2·ae) [м], 0.002·d/(λ·di·(d−di)) [км] ≡ 2·d/(λ·di·(d−di)) [м].
// Высоты hts, hrs — абсолютные (над уровнем моря), как в § 4.5.1.

/** J(ν) — потери на клине, P.526 ур. (31); 0 при ν ≤ −0.78. */
export function knifeEdgeJ(v: number): number {
  if (!(v > -0.78)) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Буллингтон с конической поправкой, ур. (57): Lb = Luc + [1 − exp(−Luc/6)]·(10 + 0.02·d[км]). */
export function bullingtonTaper(luc: number, distM: number): number {
  return luc + (1 - Math.exp(-luc / 6)) * (10 + 0.00002 * distM);
}

// ---------- § 3.1.1 / § 3.2: сферическая Земля ----------

/** Электрические параметры подстилающей поверхности для § 3.1.1.1. */
export interface Ground { epsr: number; sigma: number; vertical: boolean }
/** Суша, как в P.1812/P.452 (εr = 22, σ = 0.003 См/м); поляризация вертикальная (типичные диполи дрона). */
export const LAND_V: Ground = { epsr: 22, sigma: 0.003, vertical: true };

/**
 * Первый член ряда вычетов, § 3.1.1.2, ур. (11a)–(18b). Возвращает потери A = −20·lg(E/E0), дБ.
 * dKm — длина трассы (км), h1, h2 — высоты антенн над сферой (м), aeKm — радиус (км), fMHz — частота.
 */
export function sphericalFirstTerm(dKm: number, h1: number, h2: number, aeKm: number, fMHz: number, g: Ground = LAND_V): number {
  const s = 18000 * g.sigma / fMHz;
  const KH = 0.36 * Math.pow(aeKm * fMHz, -1 / 3) * Math.pow((g.epsr - 1) ** 2 + s * s, -0.25); // (11a)
  const K = g.vertical ? KH * Math.sqrt(g.epsr ** 2 + s * s) : KH;                               // (12a)
  const K2 = K * K, K4 = K2 * K2;
  const beta = (1 + 1.6 * K2 + 0.67 * K4) / (1 + 4.5 * K2 + 1.53 * K4);                          // (16)
  const X = 2.188 * beta * Math.cbrt(fMHz) * Math.pow(aeKm, -2 / 3) * dKm;                        // (14a)
  const yk = 9.575e-3 * beta * Math.pow(fMHz, 2 / 3) * Math.pow(aeKm, -1 / 3);                    // (15a)
  const F = X >= 1.6 ? 11 + 10 * Math.log10(X) - 17.6 * X : -20 * Math.log10(X) - 5.6488 * Math.pow(X, 1.425); // (17a,b)
  const gMin = 2 + 20 * Math.log10(K);
  const G = (h: number) => {
    const B = beta * yk * Math.max(h, 0);                                                         // (18b), B = β·Y
    const v = B > 2 ? 17.6 * Math.sqrt(B - 1.1) - 5 * Math.log10(B - 1.1) - 8 : 20 * Math.log10(B + 0.1 * B ** 3); // (18), (18a)
    return v < gMin ? gMin : v; // при B = 0 lg → −∞, ограничение снизу 2 + 20·lg K (§ 3.1.1.2)
  };
  return -(F + G(h1) + G(h2));                                                                     // (13)
}

/**
 * Дифракция над гладкой сферической Землёй на любом расстоянии, § 3.2, ур. (21)–(25).
 * d — длина трассы, h1, h2 — высоты антенн над сферой, ae — эквивалентный радиус (все в м).
 */
export function sphericalEarthLoss(d: number, h1: number, h2: number, ae: number, fMHz: number, lambda: number, g: Ground = LAND_V): number {
  h1 = Math.max(h1, 0); h2 = Math.max(h2, 0);
  const s1 = Math.sqrt(h1), s2 = Math.sqrt(h2);
  const dlos = Math.sqrt(2 * ae) * (s1 + s2);                                        // (21)
  if (d >= dlos) return sphericalFirstTerm(d / 1000, h1, h2, ae / 1000, fMHz, g);    // за горизонтом: § 3.1.1
  // Наименьший просвет между лучом и сферой, (22)–(22e).
  const c = (h1 - h2) / (h1 + h2);                                                   // (22d)
  const m = (d * d) / (4 * ae * (h1 + h2));                                          // (22e)
  let b: number;
  if (m < 1e-12) b = c; // предел (22c) при m → 0 (почти плоская Земля), избегаем ∞·0
  else {
    const arg = Math.min(1, Math.max(-1, ((3 * c) / 2) * Math.sqrt((3 * m) / (m + 1) ** 3)));
    b = 2 * Math.sqrt((m + 1) / (3 * m)) * Math.cos(Math.PI / 3 + Math.acos(arg) / 3); // (22c)
  }
  const d1 = (d / 2) * (1 + b), d2 = d - d1;                                         // (22a), (22b)
  const h = ((h1 - (d1 * d1) / (2 * ae)) * d2 + (h2 - (d2 * d2) / (2 * ae)) * d1) / d; // (22)
  const hreq = 0.552 * Math.sqrt(Math.max(0, (d1 * d2 * lambda) / d));              // (23)
  if (h > hreq) return 0;
  const aem = 0.5 * (d / (s1 + s2)) ** 2;                                            // (24)
  const Ah = sphericalFirstTerm(d / 1000, h1, h2, aem / 1000, fMHz, g);
  if (!(Ah > 0)) return 0;
  // Предел hreq → 0: просвет у конца трассы (антенна на нулевой высоте) — берём полный член, без 0/0.
  if (!(hreq > 1e-9)) return h > 0 ? 0 : Ah;
  return (1 - h / hreq) * Ah;                                                        // (25)
}

// ---------- § 4.5.1: Буллингтон ----------

export interface BullingtonResult {
  lb: number;        // ур. (57)
  luc: number;       // ур. (52) или (56)
  los: boolean;      // случай 1 (Stim < Str)
  edges: number[];   // индексы профиля: точка νmax (случай 1) или горизонты Stim/Srim (случай 2)
}

/**
 * Буллингтон по произвольному профилю, § 4.5.1, ур. (49)–(57).
 * d[i], h[i] — расстояние от передатчика и высота рельефа над уровнем моря (i = 0..n), hts/hrs — абсолютные
 * высоты антенн. Промежуточные точки — i = 1..n−1.
 */
export function bullington(d: ArrayLike<number>, h: ArrayLike<number>, hts: number, hrs: number, ae: number, lambda: number): BullingtonResult {
  const n = d.length - 1;
  const D = d[n] - d[0];
  const k2 = 1 / (2 * ae);
  let stim = -Infinity, iT = -1;
  for (let i = 1; i < n; i++) {
    const di = d[i] - d[0];
    const s = (h[i] + di * (D - di) * k2 - hts) / di;                                 // (49)
    if (s > stim) { stim = s; iT = i; }
  }
  const str = (hrs - hts) / D;                                                       // (50)
  const caseLos = (): BullingtonResult => {
    let vmax = -Infinity, iv = -1;
    for (let i = 1; i < n; i++) {
      const di = d[i] - d[0], dr = D - di;
      const v = (h[i] + di * dr * k2 - (hts * dr + hrs * di) / D) * Math.sqrt((2 * D) / (lambda * di * dr)); // (51)
      if (v > vmax) { vmax = v; iv = i; }
    }
    const luc = knifeEdgeJ(vmax);                                                    // (52)
    return { lb: bullingtonTaper(luc, D), luc, los: true, edges: luc > 0 ? [iv] : [] };
  };
  if (stim < str) return caseLos();
  let srim = -Infinity, iR = -1;
  for (let i = 1; i < n; i++) {
    const di = d[i] - d[0], dr = D - di;
    const s = (h[i] + di * dr * k2 - hrs) / dr;                                       // (53)
    if (s > srim) { srim = s; iR = i; }
  }
  const vb = bullingtonPointNu(stim, srim, hts, hrs, D, lambda);
  if (vb === null) return caseLos(); // скользящее касание: точка Буллингтона на линии A–B, случай 1 даёт тот же ν≈0
  const luc = knifeEdgeJ(vb);                                                        // (56)
  return { lb: bullingtonTaper(luc, D), luc, los: false, edges: iT === iR ? [iT] : [Math.min(iT, iR), Math.max(iT, iR)] };
}

/** ν точки Буллингтона, ур. (54)–(55); null, если наклоны вырождены (Stim + Srim ≈ 0). */
export function bullingtonPointNu(stim: number, srim: number, hts: number, hrs: number, D: number, lambda: number): number | null {
  const den = stim + srim;
  if (!(den > 1e-9)) return null;
  const db = (hrs - hts + srim * D) / den;                                           // (54)
  if (!(db > 0 && db < D)) return null;
  return (hts + stim * db - (hts * (D - db) + hrs * db) / D) * Math.sqrt((2 * D) / (lambda * db * (D - db))); // (55)
}

/** Индекс максимума унимодальной последовательности f(lo..hi) двоичным поиском (сначала растёт, потом не растёт). */
function argmaxUnimodal(lo: number, hi: number, f: (i: number) => number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f(mid) < f(mid + 1)) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Буллингтон для гладкого профиля (все hi = 0, § 4.5.2 перед ур. (64)) с равным шагом D/n — за O(log n).
 * При hi = 0 и hts, hrs ≥ 0 выражение (49) по di вогнуто, (53) — тоже, а ν из (51) унимодален
 * (в переменной t = √(di/(D−di)): ν ∝ K·t/(1+t²) − hts/t − hrs·t, производная меняет знак не более одного раза),
 * поэтому дискретный максимум находится двоичным поиском и совпадает с полным перебором.
 */
export function bullingtonSmooth(n: number, D: number, hts: number, hrs: number, ae: number, lambda: number): number {
  if (n < 2) return 0;
  hts = Math.max(hts, 0); hrs = Math.max(hrs, 0);
  const step = D / n, k2 = 1 / (2 * ae);
  const sT = (i: number) => { const di = i * step; return (di * (D - di) * k2 - hts) / di; };      // (49), hi = 0
  const stim = sT(argmaxUnimodal(1, n - 1, sT));
  const str = (hrs - hts) / D;                                                                   // (50)
  const nu = (i: number) => {
    const di = i * step, dr = D - di;
    return (di * dr * k2 - (hts * dr + hrs * di) / D) * Math.sqrt((2 * D) / (lambda * di * dr)); // (51), hi = 0
  };
  const caseLos = () => bullingtonTaper(knifeEdgeJ(nu(argmaxUnimodal(1, n - 1, nu))), D);
  if (stim < str) return caseLos();
  const sR = (i: number) => { const di = i * step, dr = D - di; return (di * dr * k2 - hrs) / dr; }; // (53), hi = 0
  const srim = sR(argmaxUnimodal(1, n - 1, sR));
  const vb = bullingtonPointNu(stim, srim, hts, hrs, D, lambda);
  return vb === null ? caseLos() : bullingtonTaper(knifeEdgeJ(vb), D);
}

// ---------- § 4.5.2: эффективные высоты над гладкой поверхностью ----------

/**
 * Высоты гладкой поверхности у концов трассы, ур. (60a)–(63d), по уже посчитанным суммам:
 * v1, v2 — ур. (58), (59); hobs, aobt, aobr — ур. (61a)–(61c) (−∞, если промежуточных точек нет);
 * h1, hn — рельеф под антеннами. Возвращает [hst, hsr] (м над уровнем моря).
 */
export function smoothSurfaceHeights(v1: number, v2: number, D: number, hobs: number, aobt: number, aobr: number, h1: number, hn: number): [number, number] {
  let hst = (2 * v1 * D - v2) / (D * D);                                             // (60a)
  let hsr = (v2 - v1 * D) / (D * D);                                                 // (60b)
  if (hobs > 0) {                                                                    // (62a)–(62f)
    const gt = aobt / (aobt + aobr), gr = aobr / (aobt + aobr);
    hst -= hobs * gt;
    hsr -= hobs * gr;
  }
  return [Math.min(hst, h1), Math.min(hsr, hn)];                                     // (63a)–(63d)
}

/** Суммы регрессии (58), (59) по профилю целиком. */
export function regressionSums(d: ArrayLike<number>, h: ArrayLike<number>): [number, number] {
  let v1 = 0, v2 = 0;
  for (let i = 1; i < d.length; i++) {
    const dd = d[i] - d[i - 1];
    v1 += dd * (h[i] + h[i - 1]);                                                    // (58)
    v2 += dd * (h[i] * (2 * d[i] + d[i - 1]) + h[i - 1] * (d[i] + 2 * d[i - 1]));    // (59)
  }
  return [v1, v2];
}

// ---------- § 4.5.2: полный метод ----------

export interface DeltaBullingtonResult {
  loss: number;   // ур. (66)
  lba: number;    // Буллингтон по реальному профилю
  lbs: number;    // Буллингтон по гладкому профилю с эффективными высотами (64a,b)
  lsph: number;   // сферическая Земля § 3.2 с высотами (65a,b)
  los: boolean;   // случай 1 Буллингтона по реальному профилю
  edges: number[];
}

/**
 * Завершение § 4.5.2 по готовым Lba и эффективным высотам поверхности: ур. (64)–(66).
 * n — число интервалов равношагового профиля (для Буллингтона по нулевому профилю).
 */
export function deltaBullingtonTail(lba: number, hts: number, hrs: number, hst: number, hsr: number, n: number, D: number, ae: number, fMHz: number, lambda: number): { loss: number; lbs: number; lsph: number } {
  const htsP = hts - hst, hrsP = hrs - hsr;                                          // (64a), (64b)
  const lbs = bullingtonSmooth(n, D, htsP, hrsP, ae, lambda);
  const lsph = sphericalEarthLoss(D, htsP, hrsP, ae, fMHz, lambda);                  // (65a), (65b)
  return { loss: lba + Math.max(lsph - lbs, 0), lbs, lsph };                         // (66)
}

/**
 * Дельта-Буллингтон, P.526-15 § 4.5.2, для равношагового профиля.
 * elev — рельеф над уровнем моря (n+1 точек), dist — длина трассы, hts/hrs — абсолютные высоты антенн,
 * ae — эквивалентный радиус Земли (м).
 */
export function deltaBullington(elev: ArrayLike<number>, dist: number, hts: number, hrs: number, ae: number, fMHz: number, lambda: number): DeltaBullingtonResult {
  const n = elev.length - 1;
  const d = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) d[i] = (dist * i) / n;
  const ba = bullington(d, elev, hts, hrs, ae, lambda);
  const [v1, v2] = regressionSums(d, elev);
  let hobs = -Infinity, aobt = -Infinity, aobr = -Infinity;
  for (let i = 1; i < n; i++) {
    const hob = elev[i] - (hts * (dist - d[i]) + hrs * d[i]) / dist;                 // (61d), плоская Земля
    if (hob > hobs) hobs = hob;                                                      // (61a)
    if (hob / d[i] > aobt) aobt = hob / d[i];                                        // (61b)
    if (hob / (dist - d[i]) > aobr) aobr = hob / (dist - d[i]);                      // (61c)
  }
  const [hst, hsr] = smoothSurfaceHeights(v1, v2, dist, hobs, aobt, aobr, elev[0], elev[n]);
  const t = deltaBullingtonTail(ba.lb, hts, hrs, hst, hsr, n, dist, ae, fMHz, lambda);
  return { loss: t.loss, lba: ba.lb, lbs: t.lbs, lsph: t.lsph, los: ba.los, edges: ba.edges };
}
