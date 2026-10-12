import { describe, expect, it } from 'vitest';
import { DEM_MAX_Z, DemGrid, DemMissingError, sampleGrid, zoomForStep } from './elevation';

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
