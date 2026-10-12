import { describe, expect, it } from 'vitest';
import { DEM_MAX_Z, DemGrid, DemMissingError, sampleGrid, zoomForStep, sampleRay, demPlan, demPixelM, demQualityHint } from './elevation';
import { lonLatToPixel, R_EARTH } from './geo';

/** Сетка 4×3 с линейным полем f(x, y) = 10·x + 100·y (x,y — индексы ячеек): билинейная интерполяция точна. */
function linGrid(): DemGrid {
  const width = 4, height = 3, data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = 10 * x + 100 * y;
  return { z: 12, px0: 1000, py0: 2000, width, height, data };
}

describe('sampleGrid (билинейная; значение ячейки — в её центре, +0.5 px)', () => {
  const g = linGrid();
  it('в центрах ячеек — точные значения', () => {
    expect(sampleGrid(g, 1000.5, 2000.5)).toBeCloseTo(0, 9);
    expect(sampleGrid(g, 1001.5, 2000.5)).toBeCloseTo(10, 9);
    expect(sampleGrid(g, 1000.5, 2001.5)).toBeCloseTo(100, 9);
    expect(sampleGrid(g, 1002.5, 2001.5)).toBeCloseTo(120, 9);
  });
  it('между центрами — линейная интерполяция', () => {
    expect(sampleGrid(g, 1001.0, 2000.5)).toBeCloseTo(5, 6);
    expect(sampleGrid(g, 1000.5, 2001.0)).toBeCloseTo(50, 6);
    expect(sampleGrid(g, 1001.25, 2000.75)).toBeCloseTo(10 * 0.75 + 100 * 0.25, 5);
  });
  it('билинейность на нелинейных данных: среднее четырёх углов в центре квадрата', () => {
    const q: DemGrid = { z: 12, px0: 0, py0: 0, width: 2, height: 2, data: new Float32Array([0, 10, 20, 100]) };
    expect(sampleGrid(q, 1.0, 1.0)).toBeCloseTo(32.5, 6);
  });
  it('за границами — зажимается к краю, без NaN', () => {
    expect(sampleGrid(g, -5000, -5000)).toBeCloseTo(0, 6);
    const far = sampleGrid(g, 9999, 9999);
    expect(Number.isFinite(far)).toBe(true);
    expect(far).toBeCloseTo(sampleGrid(g, 1003.499, 2002.499), 2);
  });
  it('учитывает смещение px0/py0', () => {
    const g2 = { ...linGrid(), px0: 0, py0: 0 };
    expect(sampleGrid(g2, 1.5, 1.5)).toBeCloseTo(110, 9);
  });
});

describe('zoomForStep', () => {
  it('всегда в [8, 15]', () => {
    for (const lat of [-80, -45, 0, 30, 55.75, 70, 85]) {
      for (const step of [0.1, 1, 5, 30, 100, 1000, 1e5]) {
        const z = zoomForStep(lat, step);
        expect(z).toBeGreaterThanOrEqual(8);
        expect(z).toBeLessThanOrEqual(DEM_MAX_Z);
        expect(Number.isInteger(z)).toBe(true);
      }
    }
  });
  it('шаг пикселя ≈ шагу выборки (в пределах √2)', () => {
    for (const [lat, step] of [[55.75, 30], [0, 100], [43, 20]]) {
      const z = zoomForStep(lat, step);
      const mpp = (40075016.7 * Math.cos((lat * Math.PI) / 180)) / 256 / 2 ** z;
      expect(mpp / step).toBeGreaterThan(Math.SQRT1_2 - 0.01);
      expect(mpp / step).toBeLessThan(Math.SQRT2 + 0.01);
    }
  });
  it('мельче шаг → не меньший zoom; широта выше → не больший zoom', () => {
    expect(zoomForStep(55, 10)).toBeGreaterThanOrEqual(zoomForStep(55, 100));
    expect(zoomForStep(70, 50)).toBeLessThanOrEqual(zoomForStep(0, 50));
  });
  it('известные значения: экватор 30 м → z12 (38 м/px); крупный шаг → 8; мелкий → 15', () => {
    expect(zoomForStep(0, 30)).toBe(12);
    expect(zoomForStep(0, 1e5)).toBe(8);
    expect(zoomForStep(0, 0.1)).toBe(15);
  });
});

describe('DemMissingError', () => {
  it('Error с числом тайлов в сообщении и поле tiles', () => {
    const e = new DemMissingError(7);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(DemMissingError);
    expect(e.tiles).toBe(7);
    expect(e.message).toContain('7');
    expect(e.name).toBe('DemMissingError');
  });
  it('различим через instanceof в try/catch', () => {
    let caught: unknown;
    try { throw new DemMissingError(3); } catch (x) { caught = x; }
    expect(caught instanceof DemMissingError).toBe(true);
    expect(caught instanceof Error).toBe(true);
  });
});

/** Сетка вокруг точки (lat 0, lon 10): пульт в узле (20, 20) мозаики 80×40. */
function rayGrid(fill: (x: number, y: number) => number) {
  const z = 12, lat = 0, lon = 10;
  const [ox, oy] = lonLatToPixel(lon, lat, z);
  const g: DemGrid = { z, px0: Math.floor(ox) - 20, py0: Math.floor(oy) - 20, width: 80, height: 40, data: new Float32Array(80 * 40) };
  for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) g.data[y * 80 + x] = fill(x, y);
  const mpp = (2 * Math.PI * R_EARTH) / (256 * 2 ** z);
  return { g, lat, lon, mpp, ox, oy };
}

describe('sampleRay (максимум в окне)', () => {
  it('узкий хребет в 1 пиксель между отсчётами не теряется (билинейка занизила бы)', () => {
    const { g, lat, lon, mpp, ox, oy } = rayGrid((x) => (x === 20 + 5 ? 500 : 100));
    const out = new Float64Array(6);
    sampleRay(g, lat, lon, 90, 4 * mpp, 6, out);
    expect(out[1]).toBe(500);
    for (const k of [1, 2]) expect(sampleGrid(g, ox + 4 * k, oy)).toBeLessThan(400);
  });
  it('ровная поверхность: везде та же высота, концы точные', () => {
    const { g, lat, lon, mpp } = rayGrid(() => 123.5);
    const out = new Float64Array(10);
    sampleRay(g, lat, lon, 45, 2 * mpp, 10, out);
    for (const v of out) expect(v).toBeCloseTo(123.5, 4);
  });
  it('out[0] — билинейно в точке пульта, а не максимум соседей', () => {
    const { g, lat, lon, ox, oy, mpp } = rayGrid((x, y) => 10 * x + 100 * y);
    const out = new Float64Array(4);
    sampleRay(g, lat, lon, 90, 3 * mpp, 4, out);
    expect(out[0]).toBeCloseTo(sampleGrid(g, ox, oy), 6);
    expect(out[1]).toBeGreaterThan(out[0]); // на восток рельеф растёт: окно даёт максимум, не среднее
  });
  it('у края мозаики без NaN', () => {
    const { g, lat, lon, mpp } = rayGrid((x) => x);
    const out = new Float64Array(200);
    sampleRay(g, lat, lon, 270, 5 * mpp, 200, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('demPlan', () => {
  it('пиксель 9–26 м, шаг не меньше пикселя и не меньше D/400', () => {
    for (const lat of [0, 30, 55, 65]) {
      const { z, step } = demPlan(lat, 30000);
      const px = demPixelM(lat, z);
      expect(px).toBeGreaterThan(9);
      expect(px).toBeLessThan(26);
      expect(step).toBeGreaterThanOrEqual(px);
      expect(step).toBeGreaterThanOrEqual(30000 / 400);
    }
  });
  it('лимит тайлов понижает z, шаг не меньше нового пикселя', () => {
    const a = demPlan(55, 5000), b = demPlan(55, 5000, (z) => 4 ** (z - 6), 256);
    expect(b.z).toBeLessThan(a.z);
    expect(b.step).toBeGreaterThanOrEqual(demPixelM(55, b.z));
  });
});

describe('demQualityHint', () => {
  it('только севернее 60° и южнее 56°', () => {
    expect(demQualityHint(55, 59)).toBeNull();
    expect(demQualityHint(55, 61)).toContain('60°');
    expect(demQualityHint(-57)).not.toBeNull();
  });
});
