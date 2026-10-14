import { describe, expect, it } from 'vitest';
import { altBands, scaleTop, AltLevel } from './altScale';

describe('scaleTop', () => {
  it('круглое число с запасом над важными высотами', () => {
    expect(scaleTop([100])).toBe(300);
    expect(scaleTop([300, 210])).toBe(400);
    expect(scaleTop([480])).toBe(600);
    expect(scaleTop([1400])).toBe(1500);
    expect(scaleTop([4000])).toBe(1500);
  });
  it('не перескакивает, пока прежний верх подходит', () => {
    expect(scaleTop([300], 800)).toBe(800);
    expect(scaleTop([100], 800)).toBe(300); // важное потерялось бы внизу шкалы
    expect(scaleTop([700], 600)).toBe(1000);
  });
  it('пустые и нечисловые отметки не ломают шкалу', () => {
    expect(scaleTop([])).toBe(300);
    expect(scaleTop([NaN, 200])).toBe(300);
  });
});

describe('altBands', () => {
  const lv = (h: number): AltLevel => (h < 37 ? 'ground' : h < 213 ? 'none' : h < 487 ? 'weak' : 'ok');
  it('полосы снизу вверх с точными (±1 м) границами', () => {
    const b = altBands(lv, 600);
    expect(b.map((x) => x.level)).toEqual(['ground', 'none', 'weak', 'ok']);
    expect(b[0].from).toBe(0);
    expect(b[b.length - 1].to).toBe(600);
    expect(Math.abs(b[1].from - 37)).toBeLessThanOrEqual(1);
    expect(Math.abs(b[2].from - 213)).toBeLessThanOrEqual(1);
    expect(Math.abs(b[3].from - 487)).toBeLessThanOrEqual(1);
    for (let i = 1; i < b.length; i++) expect(b[i].from).toBe(b[i - 1].to);
  });
  it('один уровень на всей шкале — одна полоса', () => {
    expect(altBands(() => 'ok', 300)).toEqual([{ from: 0, to: 300, level: 'ok' }]);
  });
});
