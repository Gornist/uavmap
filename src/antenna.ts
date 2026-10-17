// Антенна на земле (у пульта): всенаправленная или направленная — патч, яги, своя. У линии управления это
// антенна передатчика пульта, у видео — антенна видеоприёмника; у каждой своё направление (куда смотрит).
// Диаграмма направленности — упрощённая модель главного лепестка (как в ITU-R F.1336): ослабление
// 12·(θ/θ₃)² дБ, где θ₃ — ширина луча по уровню −3 дБ; не больше отношения «вперёд/назад» (боковые и задний лепестки).
// Наклон (угол места оси) и вертикальная ширина луча: главный лепесток — эллиптический,
//   ослабление = −min(12·((Δaz/θh)² + (Δel/θv)²), FBR), Δel = угол места на дрон − наклон оси.
// Это то же упрощение F.1336 с раздельными шириной по горизонтали θh и по вертикали θv: на краю луча в любой
// плоскости −3 дБ, по диагонали — сумма; сечение уровня — эллипс. Δaz берётся как разность азимутов
// без поправки на угол места (при больших углах места модель чуть пессимистична по азимуту) — для патча и яги,
// поднятых на 0–40°, ошибка меньше погрешности самих паспортных диаграмм.
// Чистые функции — без DOM и состояния: используются и страницей, и воркером зоны.
import type { LineId, RadioParams } from './radio';

export type AntennaKind = 'omni' | 'patch' | 'yagi' | 'custom';
export interface Antenna {
  kind: AntennaKind;
  gainDbi: number; // усиление в главном лепестке (у всенаправленной не используется — берётся из радиопараметров)
  beamDeg: number; // ширина луча по −3 дБ (по горизонтали)
  heading: number; // куда направлена, ° от севера
  /** Наклон оси: угол места, ° вверх от горизонта (TILT_MIN..TILT_MAX); нет — 0. */
  tiltDeg?: number;
  /**
   * Ширина луча по вертикали (по −3 дБ), °. Нет или ≥ 180 — вертикальная диаграмма не учитывается (как до наклона:
   * усиление не зависит от высоты дрона). У патча и яги равна горизонтальной; проект всегда хранит оба поля.
   */
  beamVDeg?: number;
}

export const ANTENNA_TYPES: Record<AntennaKind, { name: string; gainDbi: number; beamDeg: number; fbrDb: number }> = {
  omni: { name: 'Всенаправленная', gainDbi: 0, beamDeg: 360, fbrDb: 0 },
  patch: { name: 'Патч', gainDbi: 8, beamDeg: 60, fbrDb: 20 },
  yagi: { name: 'Яги', gainDbi: 13, beamDeg: 30, fbrDb: 25 },
  custom: { name: 'Своя', gainDbi: 10, beamDeg: 45, fbrDb: 20 },
};

export const DEFAULT_ANTENNA: Antenna = { kind: 'omni', gainDbi: 8, beamDeg: 60, heading: 0, tiltDeg: 0, beamVDeg: 60 };
/** Допустимый наклон оси антенны, ° (вниз — на дрон ниже пульта, вверх — пилоты задирают антенну на высокий дрон). */
export const TILT_MIN = -10, TILT_MAX = 60;
export const directional = (a: Antenna) => a.kind !== 'omni';

/** Линии с направленной антенной на земле, которые учитываются: видео — только если оно включено. */
export const directionalLines = (antenna: Record<LineId, Antenna>, videoEnabled: boolean): LineId[] =>
  (['rc', 'video'] as const).filter((x) => directional(antenna[x]) && (x === 'rc' || videoEnabled));

/** Угол между направлениями, ° (0..180). */
export function angleOff(azDeg: number, headingDeg: number): number {
  const d = (((azDeg - headingDeg) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Учитывается ли вертикальная диаграмма: направленная антенна с вертикальной шириной луча меньше 180°. */
export const hasVertical = (a: Antenna) => directional(a) && a.beamVDeg !== undefined && a.beamVDeg < 180;

/** Отношение «вперёд/назад», дБ: предел ослабления вне главного лепестка. */
export const fbrOf = (a: Antenna) => ANTENNA_TYPES[a.kind].fbrDb;

/** Слагаемое главного лепестка по азимуту 12·(Δaz/θh)², дБ — без предела FBR. */
export function azTerm(a: Antenna, azDeg: number, headingDeg: number): number {
  const off = angleOff(azDeg, headingDeg);
  const beam = Math.max(5, Math.min(180, a.beamDeg));
  return 12 * (off / beam) ** 2;
}

/** Слагаемое по углу места 12·((el − наклон)/θv)², дБ — без предела FBR (только при hasVertical). */
export function elTerm(a: Antenna, elDeg: number): number {
  const bv = Math.max(5, Math.min(180, a.beamVDeg ?? 180));
  return 12 * ((elDeg - (a.tiltDeg ?? 0)) / bv) ** 2;
}

/**
 * Ослабление относительно главного лепестка, дБ (≤ 0), для направления azDeg при оси антенны headingDeg;
 * elDeg — угол места на дрон (см. elevationDeg): без него или без вертикальной диаграммы — только по азимуту.
 */
export function patternLoss(a: Antenna, azDeg: number, headingDeg: number, elDeg?: number): number {
  if (!directional(a)) return 0;
  const t = azTerm(a, azDeg, headingDeg);
  return -Math.min(elDeg !== undefined && hasVertical(a) ? t + elTerm(a, elDeg) : t, fbrOf(a));
}

/**
 * Угол места с антенны на высоте hA на точку на высоте hB (обе — над уровнем моря) на расстоянии d по земле, °.
 * Кривизна Земли — с эквивалентным радиусом ae = k·R (как в analyzeLink): цель ниже касательной плоскости
 * на d²/(2·ae). ae передаётся готовым — без зависимости от radio.ts (clampK там).
 */
export function elevationDeg(hA: number, hB: number, d: number, ae: number): number {
  return (Math.atan2(hB - hA - (d * d) / (2 * ae), Math.max(d, 1e-6)) * 180) / Math.PI;
}

/** Румб азимута: С, ССВ, СВ … (16 направлений). */
const RUMB = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
export const rumb = (azDeg: number) => RUMB[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];

/** Направление внутри луча (по −3 дБ). */
export const inBeam = (a: Antenna, azDeg: number, headingDeg: number) => !directional(a) || angleOff(azDeg, headingDeg) <= a.beamDeg / 2;

/**
 * Наземная антенна с вертикальной диаграммой в радиопараметрах линии: её усиление зависит от угла места на дрон,
 * то есть от высоты дрона и дальности, — его досчитывает analyzeLink для своих hA, hB, dist (aimAtElevation).
 * Так поправка по углу места сама попадает во все расчёты по высоте (нужная высота, высотомер, точки потери связи).
 */
export interface GroundAim { line: LineId; antenna: Antenna; az: number }

/**
 * Антенна на земле в радиопараметрах линии: у направленной усиление наземной стороны (у управления — передатчик
 * пульта, у видео — приёмник) — по диаграмме в направлении az; без az — пиковое (антенна смотрит на цель).
 * С вертикальной диаграммой и az — ещё aim: поле усиления хранит значение без поправки по углу места
 * (верхняя оценка для потенциала и дальности без рельефа), точное — в analyzeLink.
 * Всенаправленная — параметры как есть (усиление антенны на земле — из аппаратуры).
 */
export function aimRadio(p: RadioParams, line: LineId, a: Antenna, az?: number): RadioParams {
  if (!directional(a)) return p;
  const g = a.gainDbi + (az === undefined ? 0 : patternLoss(a, az, a.heading));
  const out = line === 'rc' ? { ...p, txGainDbi: g } : { ...p, rxGainDbi: g };
  if (az !== undefined && hasVertical(a)) out.aim = { line, antenna: { ...a }, az };
  else delete out.aim;
  return out;
}

/** Радиопараметры для угла места elDeg на дрон: усиление антенны на земле — по полной диаграмме (см. GroundAim). */
export function aimAtElevation(p: RadioParams, elDeg: number): RadioParams {
  const m = p.aim;
  if (!m) return p;
  const g = m.antenna.gainDbi + patternLoss(m.antenna, m.az, m.antenna.heading, elDeg);
  return m.line === 'rc' ? { ...p, txGainDbi: g } : { ...p, rxGainDbi: g };
}
