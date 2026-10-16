import { describe, it, expect, beforeEach } from 'vitest';
import { primaryDown, reportPrimary, resetPrimary, awsTileUrl } from './demNet';

describe('предохранитель основного источника рельефа', () => {
  beforeEach(() => resetPrimary());
  it('два сбоя подряд — 5 минут сразу запасной, потом снова пробуем основной', () => {
    reportPrimary(false, 1000);
    expect(primaryDown(1000)).toBe(false);
    reportPrimary(false, 1000);
    expect(primaryDown(1001)).toBe(true);
    expect(primaryDown(1000 + 5 * 60 * 1000)).toBe(false);
  });
  it('удачный ответ сбрасывает счёт сбоев', () => {
    reportPrimary(false, 0); reportPrimary(true, 0); reportPrimary(false, 0);
    expect(primaryDown(1)).toBe(false);
  });
});

describe('адрес тайла AWS Terrarium', () => {
  it('z/x/y в адресе', () => {
    expect(awsTileUrl(13, 5010, 2988)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/5010/2988.png');
  });
});
