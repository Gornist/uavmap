import { describe, expect, it } from 'vitest';
import {
  bullington, bullingtonSmooth, bullingtonTaper, deltaBullington, knifeEdgeJ, regressionSums, smoothSurfaceHeights,
  sphericalEarthLoss, sphericalFirstTerm,
} from './diffraction';
import { analyzeLink, C, DEFAULT_RADIO, RadioParams } from './radio';
import { R_EARTH } from './geo';

const AE = (4 / 3) * R_EARTH;
const lam = (fMHz: number) => C / (fMHz * 1e6);
const P: RadioParams = { ...DEFAULT_RADIO };
const zeros = (n: number) => new Float64Array(n + 1);
const dist = (n: number, D: number) => Float64Array.from({ length: n + 1 }, (_, i) => (D * i) / n);

/**
 * Независимая реализация § 3.2 / § 3.1.1 в «практических единицах» (км, ГГц) — по структуре функций
 * dl_se / dl_se_ft_inner из Py1812 (github.com/eeveetza/Py1812, P.1812-6 ур. (22)–(36)), суша εr=22, σ=0.003,
 * вертикальная поляризация. Пишется отдельно от diffraction.ts, чтобы ловить ошибки пересчёта единиц.
 */
function refSE(dKm: number, hte: number, hre: number, apKm: number, fGHz: number): number {
  const ft = (a: number) => {
    const KH = 0.036 * (a * fGHz) ** (-1 / 3) * (21 ** 2 + (18 * 0.003 / fGHz) ** 2) ** -0.25;
    const K = KH * (22 ** 2 + (18 * 0.003 / fGHz) ** 2) ** 0.5;
    const b = (1 + 1.6 * K ** 2 + 0.67 * K ** 4) / (1 + 4.5 * K ** 2 + 1.53 * K ** 4);
    const X = 21.88 * b * (fGHz / a ** 2) ** (1 / 3) * dKm;
    const Y = (h: number) => 0.9575 * b * (fGHz ** 2 / a) ** (1 / 3) * h;
    const Fx = X >= 1.6 ? 11 + 10 * Math.log10(X) - 17.6 * X : -20 * Math.log10(X) - 5.6488 * X ** 1.425;
    const G = (B: number) => Math.max(B > 2 ? 17.6 * (B - 1.1) ** 0.5 - 5 * Math.log10(B - 1.1) - 8 : 20 * Math.log10(B + 0.1 * B ** 3), 2 + 20 * Math.log10(K));
    return -Fx - G(b * Y(hte)) - G(b * Y(hre));
  };
  const lamM = 0.299792458 / fGHz;
  const dlos = Math.sqrt(2 * apKm) * (Math.sqrt(0.001 * hte) + Math.sqrt(0.001 * hre));
  if (dKm >= dlos) return ft(apKm);
  const c = (hte - hre) / (hte + hre), m = (250 * dKm * dKm) / (apKm * (hte + hre));
  const b = 2 * Math.sqrt((m + 1) / (3 * m)) * Math.cos(Math.PI / 3 + Math.acos(((3 * c) / 2) * Math.sqrt((3 * m) / (m + 1) ** 3)) / 3);
  const d1 = (dKm / 2) * (1 + b), d2 = dKm - d1;
  const hse = ((hte - (500 * d1 * d1) / apKm) * d2 + (hre - (500 * d2 * d2) / apKm) * d1) / dKm;
  const hreq = 17.456 * Math.sqrt((d1 * d2 * lamM) / dKm);
  if (hse > hreq) return 0;
  const aem = 500 * (dKm / (Math.sqrt(hte) + Math.sqrt(hre))) ** 2;
  return (1 - hse / hreq) * Math.max(ft(aem), 0);
}

describe('§ 3.2 / § 3.1.1: сферическая Земля', () => {
  // Контрольные числа: та же независимая реализация на Python (структура Py1812 dl_se), ae = 4/3 · 6371.0088 км.
  const CASES: [number, number, number, number, number][] = [
    // d км, h1, h2 м, f МГц, ожидание дБ
    [30, 2, 10, 2440, 39.2498],   // за горизонтом (d ≥ dlos): первый член ряда
    [20, 2, 2, 868, 48.4261],
    [15, 2, 30, 2440, 10.4610],   // в пределах dlos: интерполяция (25) с aem
    [12, 10, 10, 433, 16.9414],
    [8, 2, 2, 5800, 20.9306],
  ];
  for (const [d, h1, h2, f, want] of CASES) {
    it(`${d} км, ${h1}/${h2} м, ${f} МГц → ${want} дБ (контроль Py1812-подобной реализации)`, () => {
      const L = sphericalEarthLoss(d * 1000, h1, h2, AE, f, lam(f));
      expect(L).toBeCloseTo(want, 2);
      // ±5e-4 дБ: в P.1812 ур. (25) константа 17.456, в P.526 ур. (23) — 0.552·√1000 = 17.4558
      expect(L).toBeCloseTo(refSE(d, h1, h2, AE / 1000, f / 1000), 3);
    });
  }
  it('высокие антенны с большим просветом → 0; потери растут с расстоянием и падают с высотой', () => {
    expect(sphericalEarthLoss(10000, 100, 100, AE, 2440, lam(2440))).toBe(0);
    let prev = -1;
    for (let d = 2000; d <= 60000; d += 2000) {
      const L = sphericalEarthLoss(d, 2, 30, AE, 868, lam(868));
      expect(L).toBeGreaterThanOrEqual(prev);
      prev = L;
    }
    expect(sphericalEarthLoss(30000, 2, 50, AE, 868, lam(868))).toBeLessThan(sphericalEarthLoss(30000, 2, 20, AE, 868, lam(868)));
  });
  it('непрерывность на границе dlos (ветки (21) и (25) сшиваются)', () => {
    const dlos = Math.sqrt(2 * AE) * (Math.sqrt(2) + Math.sqrt(30));
    const a = sphericalEarthLoss(dlos * 0.999, 2, 30, AE, 2440, lam(2440));
    const b = sphericalEarthLoss(dlos * 1.001, 2, 30, AE, 2440, lam(2440));
    expect(Math.abs(a - b)).toBeLessThan(0.3);
  });
  it('нулевая высота антенны: конечный результат (ограничение G ≥ 2 + 20·lg K)', () => {
    expect(Number.isFinite(sphericalEarthLoss(5000, 0, 0, AE, 2440, lam(2440)))).toBe(true);
    expect(Number.isFinite(sphericalFirstTerm(5, 0, 10, AE / 1000, 2440))).toBe(true);
  });
});

describe('§ 4.5.1: Буллингтон', () => {
  it('ур. (57): Lb = Luc + (1 − e^(−Luc/6))·(10 + 0.02·d[км]); 0 → 0', () => {
    expect(bullingtonTaper(0, 10000)).toBe(0);
    expect(bullingtonTaper(6, 10000)).toBeCloseTo(6 + (1 - Math.exp(-1)) * 10.2, 9);
  });
  it('один клин за горизонтом: точка Буллингтона = вершина клина, Luc = J(ν) (ур. 31)', () => {
    const n = 100, D = 10000, d = dist(n, D), h = zeros(n);
    h[40] = 150;
    const b = bullington(d, h, 100, 100, 1e15, lam(2440));
    const v = 50 * Math.sqrt((2 * D) / (lam(2440) * 4000 * 6000));
    expect(b.los).toBe(false);
    expect(b.edges).toEqual([40]);
    expect(b.luc).toBeCloseTo(knifeEdgeJ(v), 6);
    expect(b.lb).toBeCloseTo(bullingtonTaper(knifeEdgeJ(v), D), 6);
  });
  it('два клина за горизонтом: точка Буллингтона — пересечение лучей от обоих концов', () => {
    const n = 100, D = 10000, d = dist(n, D), h = zeros(n);
    h[25] = 60; h[75] = 60; // антенны 10 м: лучи на вершины пересекаются в середине на высоте 110 м
    const b = bullington(d, h, 10, 10, 1e15, lam(2440));
    const v = 100 * Math.sqrt((2 * D) / (lam(2440) * 5000 * 5000));
    expect(b.edges).toEqual([25, 75]);
    expect(b.luc).toBeCloseTo(knifeEdgeJ(v), 4);
  });
  it('гладкий профиль: двоичный поиск (bullingtonSmooth) совпадает с полным перебором', () => {
    for (const [n, D, ht, hr, f] of [[200, 30000, 2, 120, 2440], [300, 30000, 2, 10, 868], [50, 3000, 30, 0, 5800], [400, 40000, 0, 0, 433], [80, 8000, 15, 3, 2440], [10, 500, 10, 10, 2440]]) {
      const full = bullington(dist(n, D), zeros(n), ht, hr, AE, lam(f)).lb;
      expect(bullingtonSmooth(n, D, ht, hr, AE, lam(f))).toBeCloseTo(full, 9);
    }
  });
});

describe('§ 4.5.2: эффективные высоты и полный метод', () => {
  it('регрессия (58)–(60): постоянный и линейный профиль восстанавливаются точно', () => {
    const n = 50, D = 5000, d = dist(n, D);
    const c = Float64Array.from(d, () => 123);
    let [v1, v2] = regressionSums(d, c);
    expect(smoothSurfaceHeights(v1, v2, D, -1, 0, 0, 1e9, 1e9)).toEqual([expect.closeTo(123, 9), expect.closeTo(123, 9)]);
    const lin = Float64Array.from(d, (x) => 10 + 0.02 * x);
    [v1, v2] = regressionSums(d, lin);
    const [hst, hsr] = smoothSurfaceHeights(v1, v2, D, -1, 0, 0, 1e9, 1e9);
    expect(hst).toBeCloseTo(10, 6);
    expect(hsr).toBeCloseTo(110, 6);
    // (63): поверхность не выше рельефа под антенной
    expect(smoothSurfaceHeights(v1, v2, D, -1, 0, 0, 5, 50)).toEqual([5, 50]);
  });

  it('(1) гладкая Земля без препятствий, низкие антенны за горизонтом → результат = сферическая Земля § 3.2', () => {
    for (const [D, ht, hr, f] of [[30000, 2, 10, 2440], [20000, 2, 2, 868], [25000, 5, 20, 433]]) {
      const n = Math.round(D / 50);
      const r = deltaBullington(zeros(n), D, ht, hr, AE, f, lam(f));
      expect(r.lbs).toBeCloseTo(r.lba, 9);     // гладкий профиль ≡ реальный (hst = hsr = 0)
      expect(r.lsph).toBeGreaterThan(r.lba);    // за горизонтом сфера даёт больше Буллингтона
      expect(r.loss).toBeCloseTo(sphericalEarthLoss(D, ht, hr, AE, f, lam(f)), 9);
      expect(r.loss).toBeCloseTo(refSE(D / 1000, ht, hr, AE / 1000, f / 1000), 3);
    }
    // приподнятая гладкая Земля (плато 300 м) — то же самое: регрессия убирает 300 м
    const n = 600, D = 30000;
    const up = deltaBullington(Float64Array.from(zeros(n), () => 300), D, 302, 310, AE, 2440, lam(2440));
    expect(up.loss).toBeCloseTo(39.2498, 3);
  });

  it('(2) прямая видимость с запасом по Френелю → 0 дБ', () => {
    const n = 100, D = 5000;
    const r = deltaBullington(Float64Array.from(zeros(n), (_, i) => 20 * Math.sin(i / 7)), D, 80, 120, AE, 2440, lam(2440));
    expect(r.loss).toBe(0);
  });

  it('(3) один клин на ровной (плоской) Земле → Lb Буллингтона = J(ν) + конич. поправка, дельта-часть 0', () => {
    const n = 100, D = 10000, h = zeros(n);
    h[50] = 130;
    const r = deltaBullington(h, D, 100, 100, 1e9 * R_EARTH, 2440, lam(2440));
    const J = knifeEdgeJ(30 * Math.sqrt((2 * D) / (lam(2440) * 5000 * 5000)));
    expect(r.loss).toBeCloseTo(bullingtonTaper(J, D), 6);
    expect(r.lsph).toBe(0);
  });

  it('(4) «гребёнка» холмов: дельта-Буллингтон заметно меньше Дейгу; одиночный клин — наоборот', () => {
    // Эталоны метода Дейгу (главный клин + по одному на половинах, T = 1 − exp(−Lp/6)) сняты с прежней
    // реализации перед её удалением: гребёнка 48.12 дБ, шесть холмов 47.99 дБ, одиночный хребет 36.76 дБ.
    // Холмы sin² высотой 40 м с периодом ≈1.26 км, 8 км, пульт 2 м, дрон 100 м, 2.44 ГГц.
    const D = 8000, n = 267;
    const e = Float64Array.from({ length: n + 1 }, (_, i) => 40 * Math.max(0, Math.sin((D * i) / n / 400)) ** 2);
    const db = analyzeLink(e, D, 2, 100, P).diffraction;
    expect(db).toBeCloseTo(37.73, 1);
    expect(48.12 - db).toBeGreaterThan(6);
    // Шесть узких холмов по 30 м на 6 км, обе антенны 2 м: 42.8 против 48.0 дБ.
    const n6 = 240, D6 = 6000, e6 = zeros(n6);
    for (let i = 0; i <= n6; i++) for (let k = 1; k <= 6; k++) e6[i] = Math.max(e6[i], 30 * Math.max(0, 1 - Math.abs((D6 * i) / n6 - (D6 * k) / 7) / 150));
    const d6 = analyzeLink(e6, D6, 2, 2, P).diffraction;
    expect(d6).toBeCloseTo(42.81, 1);
    expect(47.99 - d6).toBeGreaterThan(4);
    // Одиночный хребет 150 м: поправка (57) делает метод пессимистичнее Дейгу на ≈10 дБ (46.8 против 36.8).
    const n1 = 100, D1 = 5000;
    const e1 = Float64Array.from({ length: n1 + 1 }, (_, i) => Math.max(0, 150 * (1 - Math.abs((D1 * i) / n1 - 2200) / 220)));
    const d1 = analyzeLink(e1, D1, 2, 30, P).diffraction;
    expect(d1).toBeCloseTo(46.84, 1);
    expect(d1 - 36.76).toBeCloseTo(10, 0);
  });
});

describe('нулевая высота антенны (ревью Codex)', () => {
  it('sphericalEarthLoss и analyzeLink не дают NaN при h = 0 у одного конца', async () => {
    const { sphericalEarthLoss } = await import('./diffraction');
    const { analyzeLink, DEFAULT_RADIO, C } = await import('./radio');
    const ae = (4 / 3) * 6371008.8;
    expect(Number.isFinite(sphericalEarthLoss(1000, 2, 0, ae, 2440, C / 2.44e9))).toBe(true);
    expect(Number.isFinite(sphericalEarthLoss(1000, 0, 2, ae, 2440, C / 2.44e9))).toBe(true);
    const r = analyzeLink(new Float64Array(101), 1000, 2, 0, DEFAULT_RADIO);
    expect(Number.isFinite(r.margin)).toBe(true);
    expect(Number.isFinite(r.diffraction)).toBe(true);
  });
});
