import { describe, it, expect } from 'vitest';
import { patternLoss, angleOff, inBeam, rumb, directionalLines, aimRadio, aimAtElevation, elevationDeg, hasVertical, ANTENNA_TYPES, Antenna } from './antenna';
import { analyzeLink, clampK, minHeightForLink, minHeightsForPair, RadioParams } from './radio';
import { R_EARTH } from './geo';

const patch: Antenna = { kind: 'patch', gainDbi: 8, beamDeg: 60, heading: 0 };
const omni: Antenna = { kind: 'omni', gainDbi: 0, beamDeg: 360, heading: 0 };

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
    expect(patternLoss(patch, 225, 45)).toBe(-20); // FBR патча
  });
  it('всенаправленная — без ослабления в любую сторону', () => {
    expect(patternLoss(omni, 200, 0)).toBe(0);
    expect(inBeam(omni, 200, 0)).toBe(true);
  });
  it('румб азимута', () => {
    expect([0, 45, 90, 180, 270, 349, 360, -90].map(rumb)).toEqual(['С', 'СВ', 'В', 'Ю', 'З', 'С', 'С', 'З']);
  });
  it('в луче — по половине ширины', () => {
    expect(inBeam(patch, 29, 0)).toBe(true);
    expect(inBeam(patch, 31, 0)).toBe(false);
  });
  it('учитываемые направленные антенны: видео — только включённое', () => {
    expect(directionalLines({ rc: patch, video: patch }, true)).toEqual(['rc', 'video']);
    expect(directionalLines({ rc: patch, video: patch }, false)).toEqual(['rc']);
    expect(directionalLines({ rc: omni, video: patch }, true)).toEqual(['video']);
    expect(directionalLines({ rc: omni, video: patch }, false)).toEqual([]);
    expect(directionalLines({ rc: omni, video: omni }, true)).toEqual([]);
  });
});

describe('антенна на земле в радиопараметрах линии (aimRadio — основа effRadio/effVideo пульта)', () => {
  const rp: RadioParams = { freqMHz: 5800, txPowerDbm: 28, txGainDbi: 2, rxGainDbi: 3, sensDbm: -90, lossDb: 2, clutterDb: 0, fadeMarginDb: 10, k: 4 / 3 };
  const yagi: Antenna = { kind: 'yagi', gainDbi: 13, beamDeg: 30, heading: 90 };

  it('всенаправленная — параметры как без антенны, в любую сторону', () => {
    for (const az of [undefined, 0, 90, 270]) {
      expect(aimRadio(rp, 'rc', omni, az)).toBe(rp);
      expect(aimRadio(rp, 'video', omni, az)).toBe(rp);
    }
  });
  it('патч на оси: управление — усиление передатчика пульта, видео — приёмника; остальное без изменений', () => {
    const p = { ...patch, heading: 45 };
    expect(aimRadio(rp, 'rc', p, 45)).toEqual({ ...rp, txGainDbi: 8 });
    expect(aimRadio(rp, 'video', p, 45)).toEqual({ ...rp, rxGainDbi: 8 });
    expect(rp.txGainDbi).toBe(2); // исходные параметры не меняются
    expect(rp.rxGainDbi).toBe(3);
  });
  it('без направления — пиковое усиление (антенна смотрит на цель)', () => {
    expect(aimRadio(rp, 'rc', yagi).txGainDbi).toBe(13);
    expect(aimRadio(rp, 'video', yagi).rxGainDbi).toBe(13);
  });
  it('на краю луча — на 3 дБ меньше', () => {
    expect(aimRadio(rp, 'rc', yagi, 90 + 15).txGainDbi).toBeCloseTo(10, 9);
    expect(aimRadio(rp, 'video', yagi, 90 - 15).rxGainDbi).toBeCloseTo(10, 9);
    expect(aimRadio(rp, 'rc', patch, 330).txGainDbi).toBeCloseTo(5, 9); // через север: 330° при оси 0° и луче 60°
  });
  it('сзади — минус отношение «вперёд/назад»', () => {
    expect(aimRadio(rp, 'rc', yagi, 270).txGainDbi).toBe(13 - ANTENNA_TYPES.yagi.fbrDb);
    expect(aimRadio(rp, 'video', patch, 180).rxGainDbi).toBe(8 - ANTENNA_TYPES.patch.fbrDb);
  });
  it('своя антенна — её усиление и ширина луча', () => {
    const own: Antenna = { kind: 'custom', gainDbi: 16, beamDeg: 20, heading: 0 };
    expect(aimRadio(rp, 'video', own, 0).rxGainDbi).toBe(16);
    expect(aimRadio(rp, 'video', own, 10).rxGainDbi).toBeCloseTo(13, 9);
  });
});

describe('наклон и вертикальная диаграмма', () => {
  const up: Antenna = { kind: 'patch', gainDbi: 8, beamDeg: 60, heading: 90, tiltDeg: 20, beamVDeg: 60 };
  const yagi: Antenna = { kind: 'yagi', gainDbi: 13, beamDeg: 30, heading: 0, tiltDeg: 0, beamVDeg: 30 };

  it('на оси (азимут и угол места) — без ослабления', () => {
    expect(patternLoss(up, 90, 90, 20)).toBeCloseTo(0, 12);
  });
  it('по углу места на половину вертикальной ширины — −3 дБ, вверх и вниз', () => {
    expect(patternLoss(up, 90, 90, 50)).toBeCloseTo(-3, 9);
    expect(patternLoss(up, 90, 90, -10)).toBeCloseTo(-3, 9);
    expect(patternLoss(yagi, 0, 0, 15)).toBeCloseTo(-3, 9);
  });
  it('комбинированное: край луча по азимуту и по углу места — −6 дБ; по четверти ширины — −1,5 дБ', () => {
    expect(patternLoss(up, 120, 90, 50)).toBeCloseTo(-6, 9);
    expect(patternLoss(up, 105, 90, 35)).toBeCloseTo(-1.5, 9);
  });
  it('не ниже отношения «вперёд/назад»', () => {
    expect(patternLoss(up, 90, 90, 90)).toBeCloseTo(-12 * (70 / 60) ** 2, 9); // 16,3 дБ — ещё не предел
    expect(patternLoss(yagi, 0, 0, 80)).toBe(-ANTENNA_TYPES.yagi.fbrDb);
    expect(patternLoss(yagi, 170, 0, 80)).toBe(-ANTENNA_TYPES.yagi.fbrDb);
  });
  it('без угла места или без вертикальной ширины (≥ 180, нет поля) — как раньше, только по азимуту', () => {
    expect(patternLoss(up, 120, 90)).toBe(patternLoss(patch, 30, 0));
    const flat = { ...up, beamVDeg: 180 };
    expect(hasVertical(flat)).toBe(false);
    expect(patternLoss(flat, 120, 90, 50)).toBe(patternLoss(patch, 30, 0));
    expect(patternLoss({ ...patch, heading: 90 }, 120, 90, 50)).toBe(patternLoss(patch, 30, 0)); // объект без полей
    expect(patternLoss({ ...omni, tiltDeg: 30, beamVDeg: 10 }, 0, 0, 80)).toBe(0); // всенаправленная
  });
  it('угол места — с кривизной Земли (эквивалентный радиус k·R)', () => {
    const ae = clampK(4 / 3) * R_EARTH;
    // На одной высоте цель уходит под касательную на d²/(2ae): на 10 км — минус d/(2ae) рад ≈ −0,034°.
    expect(elevationDeg(100, 100, 10000, ae)).toBeCloseTo((-10000 / (2 * ae)) * (180 / Math.PI), 7); // atan x ≈ x
    expect(elevationDeg(100, 100, 10000, ae)).toBeCloseTo(-0.0337, 3);
    // 100 м вверх на 100 м — 45° (кривизна на 100 м — меньше миллиметра).
    expect(elevationDeg(2, 102, 100, ae)).toBeCloseTo(45, 3);
    // Дрон 300 м над пультом на 5 км: atan((300 − 2 − 1,47) / 5000) ≈ 3,39°.
    expect(elevationDeg(2, 300, 5000, ae)).toBeCloseTo((Math.atan((298 - 25e6 / (2 * ae)) / 5000) * 180) / Math.PI, 9);
  });
});

describe('наклон в расчёте трассы (aim в радиопараметрах → analyzeLink)', () => {
  const rp: RadioParams = { freqMHz: 2440, txPowerDbm: 20, txGainDbi: 2, rxGainDbi: 2, sensDbm: -108, lossDb: 4, clutterDb: 0, fadeMarginDb: 10, k: 4 / 3 };
  const yagi: Antenna = { kind: 'yagi', gainDbi: 13, beamDeg: 30, heading: 0, tiltDeg: 0, beamVDeg: 30 };
  const flat = new Float32Array(101).fill(100);

  it('aim — только с вертикальной диаграммой и направлением; исходные параметры не трогает', () => {
    expect(aimRadio(rp, 'rc', yagi, 0).aim).toEqual({ line: 'rc', antenna: yagi, az: 0 });
    expect(aimRadio(rp, 'rc', yagi).aim).toBeUndefined(); // без направления — пиковое, как раньше
    expect(aimRadio(rp, 'rc', { ...yagi, beamVDeg: 180 }, 0).aim).toBeUndefined();
    expect(rp.aim).toBeUndefined();
    const v = aimRadio(rp, 'video', yagi, 10);
    expect(aimAtElevation(v, 15).rxGainDbi).toBeCloseTo(13 - 12 * (10 / 30) ** 2 - 3, 9);
    expect(aimAtElevation(v, 15).txGainDbi).toBe(2);
  });
  it('запас падает на поправку по углу места на дрон; без вертикали — как раньше бит в бит', () => {
    const hA = 102, dist = 1000;
    const ae = clampK(rp.k) * R_EARTH;
    const flatAnt = aimRadio(rp, 'rc', { ...yagi, beamVDeg: 180 }, 0);
    for (const hB of [102, 200, 400]) {
      const plain = analyzeLink(flat, dist, hA, hB, flatAnt);
      const aimed = analyzeLink(flat, dist, hA, hB, aimRadio(rp, 'rc', yagi, 0));
      const el = elevationDeg(hA, hB, dist, ae);
      expect(plain.margin - aimed.margin).toBeCloseTo(Math.min(12 * (el / 30) ** 2, 25), 9);
      expect(analyzeLink(flat, dist, hA, hB, aimRadio(rp, 'rc', { kind: 'yagi', gainDbi: 13, beamDeg: 30, heading: 0 }, 0))).toEqual(plain);
    }
  });
  it('нужная высота: выше — не всегда лучше (дрон уходит из луча), «не добьёт» не по maxH', () => {
    // Яги без наклона, цель в 300 м: на 1500 м дрон почти над антенной — сзади по вертикали, связи нет;
    // а на малой высоте связь есть. Прежняя проверка «хватит ли на maxH» дала бы null.
    const p = aimRadio({ ...rp, txPowerDbm: -15 }, 'rc', yagi, 0);
    const short = new Float32Array(31).fill(100);
    const fn = (hh: number) => 100 + hh;
    expect(analyzeLink(short, 300, 102, fn(1500), p).margin).toBeLessThan(p.fadeMarginDb);
    const need = minHeightForLink(short, 300, 102, fn, p);
    expect(need).not.toBeNull();
    expect(analyzeLink(short, 300, 102, fn(need!), p).margin).toBeGreaterThanOrEqual(p.fadeMarginDb);
    expect(minHeightsForPair(short, 300, 102, fn, p, p).pair).toBe(need);
    // Узкий вертикальный луч на близкой цели: окно высот в несколько метров не проскакивает (замечание ревью).
    const narrow = aimRadio({ ...rp, txPowerDbm: 0, txGainDbi: 10, sensDbm: -79, fadeMarginDb: 6 }, 'rc',
      { kind: 'custom', gainDbi: 10, beamDeg: 45, heading: 0, tiltDeg: 7, beamVDeg: 5 }, 0);
    const flat100 = new Float32Array(17).fill(100);
    const okAt = (hh: number) => analyzeLink(flat100, 100, 102, fn(hh), narrow).margin >= narrow.fadeMarginDb;
    expect([10, 14, 25].map(okAt)).toEqual([false, true, false]);
    const nn = minHeightForLink(flat100, 100, 102, fn, narrow);
    expect(nn).not.toBeNull();
    expect(nn!).toBeGreaterThan(10);
    expect(nn!).toBeLessThanOrEqual(14);
    expect(okAt(nn!)).toBe(true);
    // Вся высота вне луча и слишком слабо — null.
    expect(minHeightForLink(short, 300, 102, fn, aimRadio({ ...rp, txPowerDbm: -60 }, 'rc', yagi, 0))).toBeNull();
  });
});
