import { describe, it, expect } from 'vitest';
import { patternLoss, angleOff, inBeam, ANTENNA_TYPES, Antenna } from './antenna';

const patch: Antenna = { kind: 'patch', ...ANTENNA_TYPES.patch };
const omni: Antenna = { kind: 'omni', gainDbi: 0, beamDeg: 360 };

describe('диаграмма направленности антенны на земле', () => {
  it('угол между направлениями — через север тоже', () => {
    expect(angleOff(350, 10)).toBe(20);
    expect(angleOff(10, 350)).toBe(20);
    expect(angleOff(90, 270)).toBe(180);
  });
  it('на оси — без ослабления, на краю луча — −3 дБ', () => {
    expect(patternLoss(patch, 45, 45)).toBeCloseTo(0, 9);
    expect(patternLoss(patch, 45 + 30, 45)).toBeCloseTo(-3, 9);
  });
  it('сзади — не ниже отношения «вперёд/назад»', () => {
    expect(patternLoss(patch, 225, 45)).toBe(-ANTENNA_TYPES.patch.fbrDb);
  });
  it('всенаправленная — без ослабления в любую сторону', () => {
    expect(patternLoss(omni, 200, 0)).toBe(0);
    expect(inBeam(omni, 200, 0)).toBe(true);
  });
  it('в луче — по половине ширины', () => {
    expect(inBeam(patch, 29, 0)).toBe(true);
    expect(inBeam(patch, 31, 0)).toBe(false);
  });
});
