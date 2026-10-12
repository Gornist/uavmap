import { describe, expect, it } from 'vitest';
import { clutterLoss, withClutter, CLUTTER } from './clutter';
import { DEFAULT_RADIO, freeSpaceRange } from './radio';

describe('clutter (местность у пульта)', () => {
  it('открытая местность — без потерь, объект параметров не копируется', () => {
    expect(clutterLoss('open', 2440)).toBe(0);
    expect(withClutter(DEFAULT_RADIO, 'open')).toBe(DEFAULT_RADIO);
  });
  it('на 2.4 ГГц — табличные значения, лес 15 дБ', () => {
    for (const c of CLUTTER) expect(clutterLoss(c.id, 2440)).toBeCloseTo(c.db24, 6);
  });
  it('на 868 МГц примерно вдвое меньше, на 5.8 ГГц не больше ×1.2', () => {
    expect(clutterLoss('forest', 868) / 15).toBeGreaterThan(0.45);
    expect(clutterLoss('forest', 868) / 15).toBeLessThan(0.6);
    expect(clutterLoss('forest', 5800)).toBeCloseTo(18, 6);
  });
  it('складывается с ручными потерями и уменьшает дальность', () => {
    const p = { ...DEFAULT_RADIO, clutterDb: 3 };
    expect(withClutter(p, 'village').clutterDb).toBeCloseTo(9, 6);
    expect(freeSpaceRange(withClutter(p, 'forest'))).toBeLessThan(freeSpaceRange(p) / 4);
  });
});
