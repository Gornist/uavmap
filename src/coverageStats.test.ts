import { describe, expect, it } from 'vitest';
import { emptyResult } from './coverageCore';
import { CoverageShown, coverageHeights, firstLossAt, heightIndex, levelAt, lineOf, lvl, paletteIndex, sameHeights, stats } from './coverageStats';

/** Результат на nH высот × rays лучей × samples отсчётов с запасом margin(hi, r, s) и обрывом loss(hi, r). */
function result(nH: number, rays: number, samples: number, margin: (hi: number, r: number, s: number) => number, loss: (hi: number, r: number) => number) {
  const res = emptyResult(nH, rays, samples);
  for (let hi = 0; hi < nH; hi++) for (let r = 0; r < rays; r++) {
    res.firstLoss[hi * rays + r] = loss(hi, r);
    for (let s = 0; s < samples; s++) res.margins[(hi * rays + r) * samples + s] = margin(hi, r, s);
  }
  return res;
}

function shown(over: Partial<CoverageShown> & Pick<CoverageShown, 'res' | 'rays' | 'heights'>): CoverageShown {
  return { center: { lat: 55, lon: 37 }, radius: 1000, step: 100, fade: 10, resV: null, fadeV: 10, prelim: false, ...over };
}

describe('lvl', () => {
  it('уверенно от порога, на грани от нуля, ниже нуля — нет', () => {
    expect(lvl(10, 10)).toBe(2);
    expect(lvl(9.9, 10)).toBe(1);
    expect(lvl(0, 10)).toBe(1);
    expect(lvl(-0.1, 10)).toBe(0);
  });
});

describe('lineOf', () => {
  const rc = shown({ res: emptyResult(1, 1, 2), rays: 1, heights: [100] });
  it('без видео — всегда управление', () => {
    expect(lineOf(rc, 'video')).toBe('rc');
    expect(lineOf(rc, 'both')).toBe('rc');
  });
  it('с видео — выбор пользователя', () => {
    const both = { ...rc, resV: emptyResult(1, 1, 2) };
    expect(lineOf(both, 'video')).toBe('video');
    expect(lineOf(both, 'both')).toBe('both');
  });
});

describe('levelAt и firstLossAt', () => {
  // 2 высоты × 2 луча × 3 отсчёта; управление уверенно везде, видео — на грани на луче 1.
  const res = result(2, 2, 3, () => 20, (hi, r) => 1000 + hi * 100 + r);
  const resV = result(2, 2, 3, (_hi, r) => (r === 1 ? 5 : 30), (hi, r) => 500 + hi * 100 + r);
  const c = shown({ res, resV, rays: 2, heights: [50, 100] });
  const o = (hi: number, r: number, s: number) => (hi * 2 + r) * 3 + s;

  it('уровень по линии и по худшей из двух', () => {
    expect(levelAt(c, 'rc')(o(1, 1, 2))).toBe(2);
    expect(levelAt(c, 'video')(o(1, 1, 2))).toBe(1);
    expect(levelAt(c, 'both')(o(1, 1, 2))).toBe(1);
    expect(levelAt(c, 'both')(o(1, 0, 2))).toBe(2);
  });
  it('без видео «обе» считается по управлению', () => {
    const rcOnly = { ...c, resV: null };
    expect(levelAt(rcOnly, 'both')(o(0, 1, 1))).toBe(2);
  });
  it('обрыв: по линии и минимум для «обеих»', () => {
    expect(firstLossAt(c, 'rc', 1, 1)).toBe(1101);
    expect(firstLossAt(c, 'video', 1, 1)).toBe(601);
    expect(firstLossAt(c, 'both', 0, 0)).toBe(500);
    expect(firstLossAt({ ...c, resV: null }, 'video', 0, 0)).toBe(1000);
  });
});

describe('stats', () => {
  it('медиана и максимум обрыва по лучам, доля площади с весом расстояния', () => {
    // 4 луча; уверенная связь только в отсчётах s ≥ 2 из 4 (вес s: 1+2+3 = 6, хорошие 2+3 = 5).
    const res = result(1, 4, 4, (_hi, _r, s) => (s >= 2 ? 20 : -5), (_hi, r) => [300, 100, 400, 200][r]);
    const [st] = stats(shown({ res, rays: 4, heights: [100] }), 'rc');
    expect(st.median).toBe(300); // сортировка 100, 200, 300, 400 → элемент [2]
    expect(st.max).toBe(400);
    expect(st.share).toBeCloseTo(5 / 6, 10);
  });
  it('по строке на высоту; «на грани» не считается уверенной связью', () => {
    const res = result(2, 1, 3, (hi) => (hi === 0 ? 5 : 15), () => 50);
    const sts = stats(shown({ res, rays: 1, heights: [50, 100] }), 'rc');
    expect(sts.map((s) => s.share)).toEqual([0, 1]);
  });
  it('без отсчётов дальше пульта — доля 0', () => {
    const [st] = stats(shown({ res: result(1, 2, 1, () => 20, () => 0), rays: 2, heights: [100] }), 'rc');
    expect(st.share).toBe(0);
  });
});

describe('paletteIndex', () => {
  it('одна высота — первый цвет, крайние — края палитры', () => {
    expect(paletteIndex(0, 1, 8)).toBe(0);
    expect(paletteIndex(0, 4, 8)).toBe(0);
    expect(paletteIndex(3, 4, 8)).toBe(7);
    expect(paletteIndex(1, 3, 8)).toBe(4); // round(0.5 · 7) = 4
  });
});

describe('coverageHeights: высота дрона всегда в расчёте, один лимит', () => {
  it('без сравнения — только высота дрона', () => {
    expect(coverageHeights([30, 60, 150], 100, false)).toEqual([100]);
  });
  it('со сравнением — список плюс высота дрона, по возрастанию, без повторов', () => {
    expect(coverageHeights([150, 30, 60, 30], 100, true)).toEqual([30, 60, 100, 150]);
    expect(coverageHeights([30, 100], 100, true)).toEqual([30, 100]);
    expect(coverageHeights([], 75, true)).toEqual([75]);
  });
  it('сверх лимита отбрасываются самые далёкие от высоты дрона; сама она остаётся', () => {
    const r = coverageHeights([10, 20, 30, 40, 50, 60, 70, 80], 45, true, 4);
    expect(r).toEqual([30, 40, 45, 50]);
    expect(coverageHeights([10, 20, 30, 40, 50, 60, 70, 80], 1000, true)).toHaveLength(8);
    expect(coverageHeights([10, 20, 30, 40, 50, 60, 70, 80], 1000, true)).toContain(1000);
  });
});

describe('heightIndex / sameHeights', () => {
  it('точная высота — её индекс; иначе ближайшая и exact = false', () => {
    expect(heightIndex([30, 100, 250], 100)).toEqual({ i: 1, exact: true });
    expect(heightIndex([30, 100, 250], 200)).toEqual({ i: 2, exact: false });
    expect(heightIndex([30, 100, 250], 0)).toEqual({ i: 0, exact: false });
  });
  it('сравнение наборов высот', () => {
    expect(sameHeights([30, 100], [30, 100])).toBe(true);
    expect(sameHeights([30, 100], [30])).toBe(false);
    expect(sameHeights([30, 100], [30, 120])).toBe(false);
  });
});
