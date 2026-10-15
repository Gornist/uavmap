import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { labelLayers, labelPaint, labelHealth, vectorAllowed, FALLBACK_MS, FAIL_LIMIT } from './labels';

describe('векторные подписи: стиль', () => {
  for (const sat of [true, false]) {
    it(`слои проходят проверку стиля MapLibre (${sat ? 'спутник' : 'светлая подложка'})`, () => {
      const style = { version: 8, glyphs: 'uavglyph://h/{fontstack}/{range}.pbf', sources: { labels: { type: 'vector', url: 'uavvec://t' } }, layers: labelLayers(sat, true) };
      expect(validateStyleMin(style as never).map((e: { message: string }) => e.message)).toEqual([]);
    });
  }
  it('краска есть для каждого слоя и только для них (applyMapStyle перекрашивает по этому списку)', () => {
    expect(Object.keys(labelPaint(true)).sort()).toEqual(labelLayers(true, true).map((l) => l.id).sort());
  });
  it('видимость слоёв — по настройке «Подписи и дороги»', () => {
    expect(labelLayers(true, false).every((l) => l.layout?.visibility === 'none')).toBe(true);
  });
});

describe('векторные подписи: переход на растровые', () => {
  // localStorage в node нет — простая замена на Map.
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), clear: () => m.clear() });
  });

  it(`переход после ${FAIL_LIMIT} сбоев подряд, удачный тайл сбрасывает счёт, переход — один раз`, () => {
    const fb = vi.fn();
    const report = labelHealth(fb, () => 1000);
    report(false); report(true); report(false);
    expect(fb).not.toHaveBeenCalled();
    report(false);
    expect(fb).toHaveBeenCalledTimes(1);
    report(false); report(false);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('не пришёл TileJSON — переход сразу', () => {
    const fb = vi.fn();
    labelHealth(fb, () => 1000)(false, true);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('после перехода векторные не пробуем FALLBACK_MS, потом — снова', () => {
    expect(vectorAllowed(5000)).toBe(true);
    const report = labelHealth(() => undefined, () => 5000);
    for (let i = 0; i < FAIL_LIMIT; i++) report(false);
    expect(vectorAllowed(5000 + 1)).toBe(false);
    expect(vectorAllowed(5000 + FALLBACK_MS - 1)).toBe(false);
    expect(vectorAllowed(5000 + FALLBACK_MS)).toBe(true);
  });

  it('отметка из будущего (переведённые часы) или мусор не блокируют векторные', () => {
    localStorage.setItem('uavmap.labels.fallback', String(10 ** 13));
    expect(vectorAllowed(5000)).toBe(true);
    localStorage.setItem('uavmap.labels.fallback', 'abc');
    expect(vectorAllowed(5000)).toBe(true);
  });
});
