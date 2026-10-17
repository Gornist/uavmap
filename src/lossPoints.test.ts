import { describe, expect, it } from 'vitest';
import { lossPoints } from './lossPoints';
import { DEFAULT_RADIO, DEFAULT_VIDEO, RadioParams, lossAlong } from './radio';

const RC: RadioParams = { ...DEFAULT_RADIO };
const VIDEO: RadioParams = { ...DEFAULT_VIDEO };

/** Равномерный профиль из n+1 точек: base + клинья {индекс: высота}. */
function profile(n: number, base = 0, spikes: Record<number, number> = {}): Float64Array {
  const e = new Float64Array(n + 1).fill(base);
  for (const [i, h] of Object.entries(spikes)) e[+i] = h;
  return e;
}

describe('lossPoints: события по пути от пульта к прицелу', () => {
  it('ровная короткая трасса — событий нет', () => {
    const r = lossPoints(profile(200), 3000, 2, 100, RC, VIDEO);
    expect(r.events).toEqual([]);
    expect(r.first).toBeNull();
  });

  it('хребет выше дрона посередине — склон (связь у хребта не раньше склона — не показывается)', () => {
    const r = lossPoints(profile(200, 0, { 100: 300 }), 4000, 2, 100, RC, VIDEO);
    expect(r.events).toEqual([{ d: 2000, kind: 'wall' }]);
    expect(r.first).toEqual({ d: 2000, kind: 'wall' });
  });

  it('хребет у самого прицела (позже 97 % трассы) — не событие: о нём скажет вердикт', () => {
    expect(lossPoints(profile(200, 0, { 199: 300 }), 4000, 2, 100, RC, VIDEO).events).toEqual([]);
  });

  it('видео пропадает раньше управления — два события по порядку от пульта', () => {
    // Слабое видео и сильное управление: на ровной трассе видео кончается раньше.
    const e = profile(200);
    const rc = { ...RC, txPowerDbm: 30 }, video = { ...VIDEO, txPowerDbm: -10 };
    const dRc = lossAlong(e, 40000, 2, 100, rc)!, dV = lossAlong(e, 40000, 2, 100, video)!;
    expect(dV).toBeLessThan(dRc - 0.03 * 40000); // условие теста: потери далеко друг от друга
    expect(dRc).toBeLessThan(0.97 * 40000);
    const r = lossPoints(e, 40000, 2, 100, rc, video);
    expect(r.events).toEqual([{ d: dV, kind: 'video' }, { d: dRc, kind: 'rc' }]);
    expect(r.first).toEqual({ d: dV, kind: 'video' });
  });

  it('потери управления и видео рядом — одно событие «нет связи» в более ранней точке', () => {
    const e = profile(200);
    const rc = { ...RC, txPowerDbm: -10 }, video = { ...VIDEO, txPowerDbm: -10 };
    const dRc = lossAlong(e, 40000, 2, 100, rc)!, dV = lossAlong(e, 40000, 2, 100, video)!;
    expect(dRc).not.toBe(dV); // условие теста: точки разные, но ближе 3 % трассы
    expect(Math.abs(dRc - dV)).toBeLessThan(0.03 * 40000);
    const r = lossPoints(e, 40000, 2, 100, rc, video);
    expect(r.events).toEqual([{ d: Math.min(dRc, dV), kind: 'both' }]);
    // Тот же профиль без склейки — два отдельных события.
    expect(lossPoints(e, 40000, 2, 100, rc, video, { mergeFrac: 0 }).events.map((x) => x.kind).sort()).toEqual(['rc', 'video']);
  });

  it('потеря связи после склона не показывается; до склона — показывается вместе со склоном', () => {
    const e = profile(200, 0, { 150: 300 }); // склон на 3/4 пути
    const weak = { ...RC, txPowerDbm: -10 };
    const dWeak = lossAlong(e, 40000, 2, 100, weak)!;
    expect(dWeak).toBeLessThan(30000); // условие теста: слабая линия теряется раньше склона
    expect(lossPoints(e, 40000, 2, 100, weak, null).events).toEqual([{ d: dWeak, kind: 'rc' }, { d: 30000, kind: 'wall' }]);
    // Сильная линия «теряется» только у склона (тень хребта) — это не раньше склона, событие одно.
    const strong = { ...RC, txPowerDbm: 40 };
    expect(lossPoints(e, 40000, 2, 100, strong, null).events).toEqual([{ d: 30000, kind: 'wall' }]);
  });

  it('без видео — только управление', () => {
    const e = profile(200);
    const rc = { ...RC, txPowerDbm: -10 };
    const dRc = lossAlong(e, 40000, 2, 100, rc)!;
    expect(dRc).not.toBeNull();
    const r = lossPoints(e, 40000, 2, 100, rc, null);
    expect(r.events).toEqual([{ d: dRc, kind: 'rc' }]);
    expect(r.first).toEqual({ d: dRc, kind: 'rc' });
  });

  it('порог «раньше прицела» настраивается', () => {
    const e = profile(200, 0, { 180: 300 }); // склон на 90 % пути
    expect(lossPoints(e, 4000, 2, 100, RC, null).events).toEqual([{ d: 3600, kind: 'wall' }]);
    expect(lossPoints(e, 4000, 2, 100, RC, null, { earlyFrac: 0.8 }).events).toEqual([]);
  });
});
