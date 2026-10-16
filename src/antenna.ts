// Антенна на земле (у пульта): всенаправленная или направленная — патч, яги, своя. У линии управления это
// антенна передатчика пульта, у видео — антенна видеоприёмника. Направление одно на пульт — «куда смотрят антенны».
// Диаграмма направленности — упрощённая модель главного лепестка (как в ITU-R F.1336): ослабление
// 12·(θ/θ₃)² дБ, где θ₃ — ширина луча по уровню −3 дБ; не больше отношения «вперёд/назад» (боковые и задний лепестки).
// Чистые функции — без DOM и состояния: используются и страницей, и воркером зоны.

export type AntennaKind = 'omni' | 'patch' | 'yagi' | 'custom';
export interface Antenna {
  kind: AntennaKind;
  gainDbi: number; // усиление в главном лепестке (у всенаправленной не используется — берётся из радиопараметров)
  beamDeg: number; // ширина луча по −3 дБ
}

export const ANTENNA_TYPES: Record<AntennaKind, { name: string; gainDbi: number; beamDeg: number; fbrDb: number }> = {
  omni: { name: 'Всенаправленная', gainDbi: 0, beamDeg: 360, fbrDb: 0 },
  patch: { name: 'Патч', gainDbi: 8, beamDeg: 60, fbrDb: 20 },
  yagi: { name: 'Яги', gainDbi: 13, beamDeg: 30, fbrDb: 25 },
  custom: { name: 'Своя', gainDbi: 10, beamDeg: 45, fbrDb: 20 },
};

export const DEFAULT_ANTENNA: Antenna = { kind: 'omni', gainDbi: 8, beamDeg: 60 };
export const directional = (a: Antenna) => a.kind !== 'omni';

/** Угол между направлениями, ° (0..180). */
export function angleOff(azDeg: number, headingDeg: number): number {
  const d = (((azDeg - headingDeg) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Ослабление относительно главного лепестка, дБ (≤ 0), для направления azDeg при оси антенны headingDeg. */
export function patternLoss(a: Antenna, azDeg: number, headingDeg: number): number {
  if (!directional(a)) return 0;
  const off = angleOff(azDeg, headingDeg);
  const beam = Math.max(5, Math.min(180, a.beamDeg));
  return -Math.min(12 * (off / beam) ** 2, ANTENNA_TYPES[a.kind].fbrDb);
}

/** Направление внутри луча (по −3 дБ). */
export const inBeam = (a: Antenna, azDeg: number, headingDeg: number) => !directional(a) || angleOff(azDeg, headingDeg) <= a.beamDeg / 2;
