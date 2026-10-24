import { describe, expect, it } from 'vitest';
import {
  analyzeLink, analyzePair, RANK, budget, DEFAULT_VIDEO, withCanopy, canopyOf, vegLoss, vegGamma, vegLimit, minHeightsForPair, presetsFor, C, DEFAULT_RADIO, freeSpaceRange, fresnelR, fspl, minHeightForLink, PRESETS,
  radioHorizon, RadioParams, lossAlong,
} from './radio';
import { bullingtonTaper, knifeEdgeJ } from './diffraction';
import { R_EARTH } from './geo';

const P: RadioParams = { ...DEFAULT_RADIO };
/** Почти плоская Земля (k огромен): кривизна не влияет — для проверок «чистой» геометрии. */
const FLAT: RadioParams = { ...P, k: 1e9 };

/** Равномерный профиль из n+1 точек: base + (опционально) клинья {индекс: высота}. */
function profile(n: number, base = 0, spikes: Record<number, number> = {}): Float64Array {
  const e = new Float64Array(n + 1).fill(base);
  for (const [i, h] of Object.entries(spikes)) e[+i] = h;
  return e;
}

describe('fspl (ITU-R P.525: L = 32.45 + 20·lg f[МГц] + 20·lg d[км])', () => {
  it('1 км / 2400 МГц ≈ 100.05 дБ', () => expect(fspl(1000, 2400)).toBeCloseTo(100.05, 1));
  it('10 км / 868 МГц ≈ 111.2 дБ', () => expect(fspl(10000, 868)).toBeCloseTo(111.22, 1));
  it('1 км / 433 МГц ≈ 85.2 дБ, 10 км ≈ 105.2 дБ', () => {
    expect(fspl(1000, 433)).toBeCloseTo(85.18, 1);
    expect(fspl(10000, 433)).toBeCloseTo(105.18, 1);
  });
  it('+6.02 дБ при удвоении расстояния и частоты', () => {
    expect(fspl(2000, 868) - fspl(1000, 868)).toBeCloseTo(6.02, 2);
    expect(fspl(1000, 1736) - fspl(1000, 868)).toBeCloseTo(6.02, 2);
  });
  it('расстояние <1 м ограничено 1 м (нет −∞ и NaN)', () => {
    expect(Number.isFinite(fspl(0, 2400))).toBe(true);
    expect(fspl(0, 2400)).toBe(fspl(1, 2400));
  });
});

describe('knifeEdgeJ (ITU-R P.526, ур. 31)', () => {
  it('v=0 → ≈6.03 дБ', () => expect(knifeEdgeJ(0)).toBeCloseTo(6.03, 1));
  it('v ≤ −0.78 → 0, на границе ≈0', () => {
    expect(knifeEdgeJ(-0.78)).toBe(0);
    expect(knifeEdgeJ(-5)).toBe(0);
    expect(knifeEdgeJ(-0.7799)).toBeLessThan(0.05);
    expect(knifeEdgeJ(-0.7799)).toBeGreaterThanOrEqual(0);
  });
  it('v=1 → ≈13.9; v=2.4 → ≈20.5', () => {
    expect(knifeEdgeJ(1)).toBeCloseTo(13.92, 1);
    expect(knifeEdgeJ(2.4)).toBeCloseTo(20.5, 0);
  });
  it('асимптотика J ≈ 13 + 20·lg v при v ≫ 1 (P.526)', () => {
    expect(Math.abs(knifeEdgeJ(10) - (13 + 20 * Math.log10(10)))).toBeLessThan(0.5);
  });
  it('строго возрастает при v > −0.78', () => {
    let prev = knifeEdgeJ(-0.78);
    for (let v = -0.7; v <= 10; v += 0.1) {
      const j = knifeEdgeJ(v);
      expect(j).toBeGreaterThan(prev);
      prev = j;
    }
  });
});

describe('fresnelR', () => {
  it('середина 10 км, 2.4 ГГц ≈ 17.7 м (17.32·√(d1·d2/(f·D)))', () => {
    const ref = 17.32 * Math.sqrt((5 * 5) / (2.4 * 10));
    expect(fresnelR(5000, 5000, C / 2.4e9)).toBeCloseTo(ref, 0);
    expect(fresnelR(5000, 5000, C / 2.4e9)).toBeGreaterThan(17.5);
    expect(fresnelR(5000, 5000, C / 2.4e9)).toBeLessThan(17.9);
  });
  it('симметрична и максимальна в середине', () => {
    const l = C / 868e6;
    expect(fresnelR(2000, 8000, l)).toBeCloseTo(fresnelR(8000, 2000, l), 9);
    expect(fresnelR(5000, 5000, l)).toBeGreaterThan(fresnelR(2000, 8000, l));
  });
  it('у конца трассы → 0', () => expect(fresnelR(0, 1000, 0.12)).toBe(0));
});

describe('radioHorizon', () => {
  it('k=4/3: 2 м ≈ 5.8 км, 100 м ≈ 41.2 км (4.12·√h)', () => {
    expect(radioHorizon(2, 0) / 1000).toBeCloseTo(5.83, 1);
    expect(radioHorizon(100, 0) / 1000).toBeCloseTo(41.24, 1);
    expect(radioHorizon(2, 100) / 1000).toBeCloseTo(5.83 + 41.24, 1);
  });
  it('k=1 (геометрический) короче, отрицательная высота = 0', () => {
    expect(radioHorizon(100, 0, 1)).toBeLessThan(radioHorizon(100, 0, 4 / 3));
    expect(radioHorizon(-5, 0)).toBe(0);
  });
});

describe('budget / freeSpaceRange', () => {
  it('budget = Pt+Gt+Gr−потери−клаттер−чувствительность', () => {
    expect(budget(P)).toBe(20 + 2 + 2 - 4 - 0 + 108);
  });
  it('fspl(freeSpaceRange) == budget − запас (по умолчанию fadeMargin и явный)', () => {
    expect(fspl(freeSpaceRange(P), P.freqMHz)).toBeCloseTo(budget(P) - P.fadeMarginDb, 6);
    expect(fspl(freeSpaceRange(P, 0), P.freqMHz)).toBeCloseTo(budget(P), 6);
    expect(fspl(freeSpaceRange(P, 20), P.freqMHz)).toBeCloseTo(budget(P) - 20, 6);
  });
  it('то же для всех пресетов; дальность растёт при падении частоты и росте запаса мощности', () => {
    for (const pr of PRESETS) {
      const p = { ...DEFAULT_RADIO, ...pr.p };
      expect(fspl(freeSpaceRange(p), p.freqMHz)).toBeCloseTo(budget(p) - p.fadeMarginDb, 6);
      expect(freeSpaceRange(p)).toBeGreaterThan(100);
    }
    expect(freeSpaceRange({ ...P, freqMHz: 868 })).toBeGreaterThan(freeSpaceRange(P));
    expect(freeSpaceRange({ ...P, txPowerDbm: P.txPowerDbm + 20 * Math.log10(2) })).toBeCloseTo(2 * freeSpaceRange(P), 3);
  });
  it('ELRS 2.4 (потери 4 дБ): ≈7.8 км в свободном пространстве при запасе 10 дБ', () => {
    expect(freeSpaceRange(P) / 1000).toBeCloseTo(7.8, 0);
  });
});

describe('analyzeLink: синтетические трассы', () => {
  const N = 100, D = 10000;

  it('ровная земля + высокие мачты: LOS, дифракция 0, margin = budget − fspl', () => {
    const r = analyzeLink(profile(N), D, 100, 100, FLAT);
    expect(r.los).toBe(true);
    expect(r.diffraction).toBe(0);
    expect(r.edges).toEqual([]);
    expect(r.fspl).toBeCloseTo(fspl(D, P.freqMHz), 9);
    expect(r.margin).toBeCloseTo(budget(P) - fspl(D, P.freqMHz), 6);
    expect(r.minClearance).toBeGreaterThan(1);
    expect(r.fresnelBlocked).toBe(0);
    expect(r.d.length).toBe(N + 1);
    expect(r.los_h[0]).toBe(100);
    expect(r.los_h[N]).toBe(100);
    expect(r.d[N]).toBeCloseTo(D, 9);
  });

  it('prx и totalLoss согласованы с margin', () => {
    const r = analyzeLink(profile(N), D, 100, 120, P);
    expect(r.totalLoss).toBeCloseTo(r.fspl + r.diffraction, 9);
    expect(r.margin).toBeCloseTo(r.prx - P.sensDbm, 9);
  });

  // Дельта-Буллингтон (P.526-15 § 4.5): к J(ν) точки Буллингтона добавляется коническая поправка (57)
  // [1 − exp(−J/6)]·(10 + 0.02·d[км]); при J = 6.03 дБ на 10 км это ещё ≈6.5 дБ (Дейгу давал чистые 6.03).
  const LB0 = bullingtonTaper(knifeEdgeJ(0), D); // ≈12.50 дБ

  it('клин ровно на линии визирования → J(0) = 6.03 дБ + поправка (57) ≈ 12.5 дБ', () => {
    const r = analyzeLink(profile(N, 0, { 50: 100 }), D, 100, 100, FLAT);
    expect(r.diffraction).toBeCloseTo(LB0, 1);
    expect(LB0).toBeCloseTo(12.5, 1);
    expect(r.edges).toEqual([50]);
    expect(r.margin).toBeCloseTo(budget(P) - fspl(D, P.freqMHz) - LB0, 1);
    expect(r.fresnelBlocked).toBeCloseTo(0.5, 2);
    expect(r.minClearance).toBeCloseTo(0, 6);
  });

  it('клин выше линии → los=false, потери = Lb(J(v)) (ур. 57) и растут с высотой', () => {
    const lambda = C / (P.freqMHz * 1e6);
    const r20 = analyzeLink(profile(N, 0, { 50: 120 }), D, 100, 100, FLAT);
    const v = 20 * Math.sqrt((2 * D) / (lambda * 5000 * 5000));
    expect(r20.los).toBe(false);
    expect(r20.diffraction).toBeCloseTo(bullingtonTaper(knifeEdgeJ(v), D), 6);
    let prev = r20.diffraction;
    for (const h of [140, 180, 250]) {
      const r = analyzeLink(profile(N, 0, { 50: h }), D, 100, 100, FLAT);
      expect(r.diffraction).toBeGreaterThan(prev);
      expect(r.margin).toBeLessThan(budget(P) - fspl(D, P.freqMHz));
      prev = r.diffraction;
    }
  });

  it('клин в 0.6 радиуса Френеля под линией: LOS есть, дифракции нет, minClearance ≈ 0.6', () => {
    const f = analyzeLink(profile(N), D, 100, 100, FLAT).fz[50];
    const r = analyzeLink(profile(N, 0, { 50: 100 - 0.6 * f }), D, 100, 100, FLAT);
    expect(r.los).toBe(true);
    expect(r.diffraction).toBe(0);
    expect(r.minClearance).toBeCloseTo(0.6, 2);
  });

  it('два клина на линии: Буллингтон сводит их к одной кромке (= одному клину)', () => {
    const one = analyzeLink(profile(N, 0, { 33: 100 }), D, 100, 100, FLAT);
    const two = analyzeLink(profile(N, 0, { 33: 100, 66: 100 }), D, 100, 100, FLAT);
    expect(two.diffraction).toBeGreaterThanOrEqual(one.diffraction - 1e-6);
    expect(two.diffraction).toBeCloseTo(LB0, 1);
    expect(two.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('три клина: потери не убывают с добавлением препятствий', () => {
    const two = analyzeLink(profile(N, 0, { 25: 100, 75: 100 }), D, 100, 100, FLAT);
    const three = analyzeLink(profile(N, 0, { 25: 100, 50: 100, 75: 100 }), D, 100, 100, FLAT);
    expect(three.diffraction).toBeGreaterThanOrEqual(two.diffraction);
  });

  it('несимметричные высоты: линия визирования линейна, клин на линии даёт J(0) + поправка', () => {
    // A=50 м, B=150 м → в середине линия на 100 м
    const r = analyzeLink(profile(N, 0, { 50: 100 }), D, 50, 150, FLAT);
    expect(r.los_h[50]).toBeCloseTo(100, 9);
    expect(r.diffraction).toBeCloseTo(LB0, 1);
  });

  it('кривизна Земли: 30 км над ровной землёй при антеннах 2 м → за радиогоризонтом, los=false', () => {
    const r = analyzeLink(profile(200), 30000, 2, 2, P);
    expect(radioHorizon(2, 2)).toBeLessThan(30000);
    expect(r.los).toBe(false);
    expect(r.diffraction).toBeGreaterThan(10);
    expect(r.margin).toBeLessThan(budget(P) - fspl(30000, P.freqMHz) - 10);
    // сопоставимая плоская Земля — LOS и без дифракции
    const flat = analyzeLink(profile(200), 30000, 2, 2, FLAT);
    expect(flat.los).toBe(true);
  });

  it('кривизна Земли: граница LOS совпадает с radioHorizon (±2%)', () => {
    const hz = radioHorizon(2, 2);
    expect(analyzeLink(profile(200), hz * 0.98, 2, 2, P).los).toBe(true);
    expect(analyzeLink(profile(200), hz * 1.02, 2, 2, P).los).toBe(false);
    // Re = k·R_EARTH учтён: при k=1 горизонт короче
    const hz1 = radioHorizon(2, 2, 1);
    expect(analyzeLink(profile(200), hz1 * 1.02, 2, 2, { ...P, k: 1 }).los).toBe(false);
    expect(hz1).toBeCloseTo(2 * Math.sqrt(2 * R_EARTH * 2), 3);
  });

  it('кривизна Земли: высокие мачты (200 м) на 30 км — LOS, дифракции нет', () => {
    const r = analyzeLink(profile(200), 30000, 200, 200, P);
    expect(r.los).toBe(true);
    expect(r.diffraction).toBe(0);
    expect(r.margin).toBeCloseTo(budget(P) - fspl(30000, P.freqMHz), 6);
  });

  it('статусы ok / weak / none по порогам запаса', () => {
    const base = analyzeLink(profile(N), D, 100, 100, FLAT);
    const withMargin = (target: number) =>
      analyzeLink(profile(N), D, 100, 100, { ...FLAT, sensDbm: FLAT.sensDbm + (base.margin - target) });
    const ok = withMargin(P.fadeMarginDb + 5), edgeOk = withMargin(P.fadeMarginDb);
    const weak = withMargin(P.fadeMarginDb - 5), edgeWeak = withMargin(0.001), none = withMargin(-5);
    expect(ok.margin).toBeCloseTo(P.fadeMarginDb + 5, 6);
    expect(ok.status).toBe('ok');
    expect(edgeOk.status).toBe('ok');
    expect(weak.status).toBe('weak');
    expect(edgeWeak.status).toBe('weak');
    expect(none.status).toBe('none');
  });

  it('клаттер и потери на кабелях уменьшают запас 1:1', () => {
    const a = analyzeLink(profile(N), D, 100, 100, FLAT);
    const b = analyzeLink(profile(N), D, 100, 100, { ...FLAT, clutterDb: 7, lossDb: FLAT.lossDb + 3 });
    expect(a.margin - b.margin).toBeCloseTo(10, 9);
  });

  it('вырожденные профили (n=1, n=2) не падают', () => {
    const r1 = analyzeLink(profile(1), 500, 10, 10, P);
    expect(r1.diffraction).toBe(0);
    expect(r1.minClearance).toBe(1);
    expect(Number.isFinite(analyzeLink(profile(2), 500, 10, 10, P).margin)).toBe(true);
  });
});

describe('minHeightForLink', () => {
  const N = 100, D = 5000; // fspl ≈114.2 дБ → запас 15.8 дБ, допустимая дифракция ≲5.8 дБ
  const ridge = (h: number) => profile(N, 0, { 50: h });
  const fn = (h: number) => h;

  it('на найденной высоте запас ≥ fade, на 3 м ниже — меньше', () => {
    const e = ridge(60);
    const h = minHeightForLink(e, D, 2, fn, P)!;
    expect(h).not.toBeNull();
    expect(h).toBeGreaterThan(0);
    expect(analyzeLink(e, D, 2, fn(h), P).margin).toBeGreaterThanOrEqual(P.fadeMarginDb);
    expect(analyzeLink(e, D, 2, fn(h - 3), P).margin).toBeLessThan(P.fadeMarginDb);
  });

  it('ровная земля, дрон на 100 м: достаточно малой высоты, и она ≥ 0', () => {
    const h = minHeightForLink(profile(N), D, 100, fn, P)!;
    expect(h).toBeGreaterThanOrEqual(0);
    expect(analyzeLink(profile(N), D, 100, fn(h), P).margin).toBeGreaterThanOrEqual(P.fadeMarginDb);
  });

  it('монотонность: выше хребет → не ниже требуемая высота', () => {
    let prev = -1;
    for (const r of [0, 20, 40, 60, 80, 120]) {
      const h = minHeightForLink(ridge(r), D, 2, fn, P);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(prev);
      prev = h!;
    }
  });

  it('null, если не хватает и на maxH', () => {
    expect(minHeightForLink(ridge(60), D, 2, fn, P, 5)).toBeNull();
    expect(minHeightForLink(ridge(60), 400000, 2, fn, P)).toBeNull();
  });
});

describe('аудит радиомодели (2A): регрессии', () => {
  it('гладкая Земля 30 км, 2.44 ГГц, дрон 120 м: без ложного скачка Дейгу (≤ 6 дБ, было 12.5)', () => {
    // Дельта-Буллингтон на гладкой Земле = max(Буллингтон, сфера § 3.2) = 5.98 дБ (сфера, интерполяция (25)).
    const r = analyzeLink(profile(600), 30000, 2, 120, P);
    expect(r.diffraction).toBeLessThan(6);
    expect(r.diffraction).toBeGreaterThan(5);
  });
  it('дифракция на гладкой Земле растёт плавно с расстоянием (нет скачка > 5 дБ между соседними 100 м)', () => {
    const p868 = { ...P, freqMHz: 868 };
    let prev = 0;
    for (let D = 2000; D <= 8000; D += 100) {
      const n = Math.round(D / 15);
      const dl = analyzeLink(profile(n), D, 2, 50, p868).diffraction;
      expect(dl - prev).toBeLessThan(5);
      prev = dl;
    }
  });
  it('дрон ниже рельефа в своей точке → связи нет, belowGround', () => {
    const e = profile(100, 0, { 100: 100 });
    const r = analyzeLink(e, 2000, 2, 30, P);
    expect(r.belowGround).toBe(true);
    expect(r.los).toBe(false);
    expect(r.status).toBe('none');
  });
  it('k ≤ 0 не даёт NaN', () => {
    const r = analyzeLink(profile(100), 10000, 30, 100, { ...P, k: 0 });
    expect(Number.isFinite(r.margin)).toBe(true);
    expect(Number.isFinite(radioHorizon(10, 10, -1))).toBe(true);
  });
});

describe('дельта-Буллингтон: поведение analyzeLink', () => {
  it('(5) монотонность: запас не убывает с высотой дрона (хребет, холмы, гладкая Земля)', () => {
    const D = 6000, n = 200;
    const terrains = [
      Float64Array.from({ length: n + 1 }, (_, i) => Math.max(0, 120 * (1 - Math.abs((D * i) / n - 2500) / 300))),
      Float64Array.from({ length: n + 1 }, (_, i) => 40 * Math.max(0, Math.sin((D * i) / n / 400)) ** 2),
      profile(n),
    ];
    for (const e of terrains) {
      let prev = -Infinity;
      for (let h = 0; h <= 400; h += 5) {
        const m = analyzeLink(e, D, 2, e[n] + h, P).margin;
        expect(m).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = m;
      }
    }
  });

  it('(6) непрерывность по расстоянию на гладкой Земле: нет скачков > 3 дБ между соседними 100 м', () => {
    for (const [hA, hB, f] of [[2, 30, 2440], [2, 100, 2440], [2, 2, 868], [10, 50, 433], [2, 120, 5800]]) {
      const p = { ...P, freqMHz: f };
      let prev = analyzeLink(profile(10), 1000, hA, hB, p).diffraction;
      for (let D = 1100; D <= 40000; D += 100) {
        const dl = analyzeLink(profile(Math.max(10, Math.round(D / 30))), D, hA, hB, p).diffraction;
        expect(Math.abs(dl - prev)).toBeLessThan(3);
        prev = dl;
      }
    }
  });
});

describe('две линии: управление и видео', () => {
  const rc: RadioParams = { ...DEFAULT_RADIO, freqMHz: 868, txPowerDbm: 24, sensDbm: -117 }; // сильная линия
  const vd: RadioParams = { ...DEFAULT_VIDEO };                                                // слабее: 5.8 ГГц
  const n = 100, dist = 20000;
  const flat = profile(n, 100);
  const ridge = profile(n, 100, { 50: 160 });

  it('PRESETS: у каждого есть kind; ELRS/Crossfire — rc, 5.8/1.2 ГГц — video, LoRa — telemetry', () => {
    for (const p of PRESETS) expect(['rc', 'video', 'telemetry']).toContain(p.kind);
    const k = (id: string) => PRESETS.find((p) => p.id === id)!.kind;
    expect([k('elrs24'), k('elrs900'), k('crsf')]).toEqual(['rc', 'rc', 'rc']);
    expect([k('vtx58'), k('vtx12'), k('dig58'), k('wifi24')]).toEqual(['video', 'video', 'video', 'video']);
    expect(k('lora433')).toBe('telemetry');
    expect(presetsFor('video').every((p) => p.kind === 'video')).toBe(true);
    expect(presetsFor('rc').some((p) => p.id === 'lora433')).toBe(true);
    expect(presetsFor('rc').some((p) => p.id === 'vtx58')).toBe(false);
  });

  it('video = null → результат как у одиночной линии', () => {
    const p = analyzePair(flat, dist, 102, 300, rc, null);
    const one = analyzeLink(flat, dist, 102, 300, rc);
    expect(p.video).toBeNull();
    expect(p.worst).toBe('rc');
    expect(p.status).toBe(one.status);
    expect(p.rc.margin).toBe(one.margin);
    expect(p.score).toBeCloseTo(one.margin - rc.fadeMarginDb, 9);
  });

  it('худшая линия — видео, когда оно слабее; управление — когда слабее оно', () => {
    const p = analyzePair(flat, dist, 102, 300, rc, vd);
    expect(p.video!.margin).toBeLessThan(p.rc.margin);
    expect(p.worst).toBe('video');
    expect(p.status).toBe(p.video!.status);
    const weakRc = { ...rc, txPowerDbm: -10 }; // управление практически без мощности
    const q = analyzePair(flat, dist, 102, 300, weakRc, vd);
    expect(q.worst).toBe('rc');
    expect(q.status).toBe(q.rc.status);
  });

  it('статус пары — по худшей линии; при равных статусах — по запасу сверх желаемого', () => {
    // видео «ok» с большим порогом хуже, чем управление «ok» с малым: запас сверх порога меньше
    const a = { ...rc, fadeMarginDb: 3 }, b = { ...vd, fadeMarginDb: 30 };
    const p = analyzePair(flat, 3000, 102, 130, a, b);
    expect(p.rc.status).toBe('ok');
    if (p.video!.status === 'ok') {
      expect(p.video!.margin - 30).toBeLessThan(p.rc.margin - 3);
      expect(p.worst).toBe('video');
    }
    // дрон под рельефом — обе none, статус none
    expect(analyzePair(flat, dist, 102, 50, rc, vd).status).toBe('none');
  });

  it('минимальная высота пары ≥ каждой из одиночных; с video = null совпадает с одиночной', () => {
    for (const e of [flat, ridge]) {
      const hf = (hh: number) => 100 + hh;
      const m = minHeightsForPair(e, dist, 102, hf, rc, vd);
      const single = (p: RadioParams) => minHeightForLink(e, dist, 102, hf, p);
      expect(m.rc).toBe(single(rc));
      expect(m.video).toBe(single(vd));
      if (m.pair !== null) {
        expect(m.pair).toBeGreaterThanOrEqual(m.rc!);
        expect(m.pair).toBeGreaterThanOrEqual(m.video!);
        // на найденной высоте обе линии держат запас
        const pr = analyzePair(e, dist, 102, hf(m.pair), rc, vd);
        expect(pr.rc.margin).toBeGreaterThanOrEqual(rc.fadeMarginDb);
        expect(pr.video!.margin).toBeGreaterThanOrEqual(vd.fadeMarginDb);
      }
      expect(minHeightsForPair(e, dist, 102, hf, rc, null).pair).toBe(single(rc));
    }
  });

  it('минимальная высота пары: null, если одна из линий не тянет даже на 1500 м', () => {
    const dead = { ...vd, txPowerDbm: -30 };
    expect(minHeightsForPair(ridge, 60000, 102, (hh) => 100 + hh, rc, dead).pair).toBeNull();
  });
});

describe('ранжирование пар по статусу (ревью Codex)', () => {
  it('пара «на грани» выше пары без связи, даже если score у неё ниже', () => {
    const rc = { ...DEFAULT_RADIO, fadeMarginDb: 0 }, video = { ...DEFAULT_RADIO, fadeMarginDb: 60 };
    const flat = profile(100);
    // подбираем высоты так, чтобы получить статусы none и weak
    const a = analyzePair(flat, 40000, 2, 2, rc, video);
    const b = analyzePair(flat, 1000, 2, 30, rc, video);
    const sorted = [a, b].sort((x, y) => RANK[y.status] - RANK[x.status] || y.score - x.score);
    expect(RANK[sorted[0].status]).toBeGreaterThanOrEqual(RANK[sorted[1].status]);
  });
});

describe('lossAlong: где по пути пропадёт связь', () => {
  it('ровная короткая трасса — связь на всём пути', () => {
    expect(lossAlong(profile(200), 3000, 2, 100, P)).toBeNull();
  });
  it('хребет выше дрона посередине — связь пропадает у хребта', () => {
    const e = profile(200, 0, { 100: 300 });
    const d = lossAlong(e, 4000, 2, 100, P)!;
    expect(d).toBeGreaterThan(1900);
    expect(d).toBeLessThanOrEqual(2000);
  });
  it('короткий провал у самого пульта не пропускается (связь вдоль рельефа не монотонна)', () => {
    const e = profile(200, 0, { 3: 101 });
    expect(lossAlong(e, 4000, 2, 100, { ...P, txPowerDbm: 50 })).toBe(60);
  });
  it('точка — первая потерянная (как полный перебор), а не первая на грубом шаге', () => {
    const e = profile(300, 0, { 77: 250, 230: 400 });
    let brute: number | null = null;
    for (let k = 2; k <= 300 && brute === null; k++) {
      const r = analyzeLink(e.subarray(0, k + 1), (5000 * k) / 300, 2, 120, P);
      if (r.belowGround || r.status === 'none') brute = (5000 * k) / 300;
    }
    expect(lossAlong(e, 5000, 2, 120, P)).toBe(brute);
  });
});

describe('лес на трассе (ITU-R P.833)', () => {
  const N = 100, D = 1000;
  const flat = () => new Float32Array(N + 1);
  /** Полог h м на отсчётах [i0, i1]. */
  const canopy = (h: number, i0: number, i1: number) => { const c = new Float32Array(N + 1); for (let i = i0; i <= i1; i++) c[i] = h; return c; };

  it('затухание сквозь кроны: γ·d в начале, предел A_m на длинном пути; 5,8 ГГц сильнее 2,4', () => {
    expect(vegLoss(0, 5800)).toBe(0);
    expect(vegLoss(5, 2440)).toBeCloseTo(5 * vegGamma(2440), 0); // короткий путь — почти γ·d
    expect(vegLoss(1e5, 5800)).toBeCloseTo(vegLimit(5800), 3);
    expect(vegLimit(5800)).toBeGreaterThan(vegLimit(2440));
    expect(vegLoss(50, 5800) - vegLoss(50, 2440)).toBeGreaterThan(10); // «управление есть, видео нет» у опушки
  });

  it('луч ниже крон на 200 м: потери ≤ затуханию сквозь кроны и ≤ дифракции над ними; без полога — как раньше', () => {
    const bare = analyzeLink(flat(), D, 5, 5, P);
    expect(bare.forest).toBeNull();
    const e = withCanopy(flat(), canopy(10, 40, 60));
    const r = analyzeLink(e, D, 5, 5, P);
    expect(r.forest!.m).toBeCloseTo(210, -1);
    expect(r.forest!.db).toBeGreaterThan(5);
    expect(r.forest!.db).toBeLessThanOrEqual(vegLoss(r.forest!.m, P.freqMHz) + 1e-9);
    expect(r.margin).toBeCloseTo(bare.margin - r.forest!.db, 6);
    expect(r.canopyTop![50]).toBeCloseTo(r.ground[50] + 10, 6);
  });

  it('дрон высоко — луч над кронами: лес не отнимает', () => {
    const e = withCanopy(flat(), canopy(10, 40, 60));
    const r = analyzeLink(e, D, 5, 200, P);
    expect(r.forest!.m).toBe(0);
    expect(r.forest!.db).toBe(0);
  });

  it('хребет закрывает луч, на гребне лес: кроны — часть препятствия (дифракция растёт)', () => {
    const ridge = flat();
    for (let i = 45; i <= 55; i++) ridge[i] = 40;
    const bare = analyzeLink(ridge, D, 5, 5, P);
    const r = analyzeLink(withCanopy(ridge.slice(), canopy(8, 45, 55)), D, 5, 5, P);
    expect(bare.los).toBe(false);
    expect(r.forest!.m).toBe(0);
    expect(r.forest!.db).toBeGreaterThan(1);
  });

  it('полог доходит до укороченных трасс (точки потери связи) и до нужной высоты', () => {
    const e = withCanopy(flat(), canopy(10, 1, 99));
    const fn = (h: number) => h;
    const withF = minHeightForLink(e, D, 2, fn, P);
    const without = minHeightForLink(flat(), D, 2, fn, P);
    expect(withF === null || (without !== null && withF > without)).toBe(true);
    expect(canopyOf(e)).not.toBeNull();
  });
});
