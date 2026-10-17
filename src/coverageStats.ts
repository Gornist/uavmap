// Зона покрытия: чистые функции над готовым результатом расчёта — уровень связи в отсчёте,
// дальность до первого обрыва, статистика по высотам, индекс цвета палитры. Без DOM и состояния.
import type { CoverageResult } from './coverageCore';
import type { LatLon } from './geo';
import { COV_MAX_HEIGHTS } from './store';

/** Показанный (или показываемый) результат расчёта зоны. */
export interface CoverageShown {
  res: CoverageResult;
  center: LatLon; radius: number; step: number; rays: number; heights: number[];
  fade: number; // порог, с которым считался firstLoss — растр и статистика используют его же
  resV: CoverageResult | null; // линия «Видео» (null — при расчёте она была выключена)
  fadeV: number;
  prelim: boolean; // предварительный грубый проход (лучей ×¼, шаг ×2), полный ещё считается
}

export type CovLine = 'rc' | 'video' | 'both';

/** Что показывать: если видео не считалось — только управление (want — выбор пользователя). */
export const lineOf = (c: CoverageShown, want: CovLine): CovLine => (c.resV ? want : 'rc');

/** Уровень связи: 0 — нет, 1 — на грани, 2 — уверенно (относительно собственного порога линии). */
export const lvl = (m: number, fade: number) => (m >= fade ? 2 : m >= 0 ? 1 : 0);

/**
 * Уровень в отсчёте o = (hi · rays + r) · samples + s (высота hi, луч r, отсчёт s) для линии;
 * «обе» = минимум уровней — по худшей.
 */
export function levelAt(c: CoverageShown, line: CovLine): (o: number) => number {
  const a = line !== 'video' ? c.res.margins : null;
  const b = line !== 'rc' && c.resV ? c.resV.margins : null;
  const fa = c.fade, fb = c.fadeV;
  return (o: number) => {
    let l = 2;
    if (a) l = lvl(a[o], fa);
    if (b) l = Math.min(l, lvl(b[o], fb));
    return l;
  };
}

/** Расстояние до первого обрыва; для «обеих» — минимум из двух линий. */
export function firstLossAt(c: CoverageShown, line: CovLine, hi: number, r: number): number {
  const i = hi * c.rays + r;
  const a = c.res.firstLoss[i], b = c.resV ? c.resV.firstLoss[i] : Infinity;
  return line === 'rc' || !c.resV ? a : line === 'video' ? b : Math.min(a, b);
}

export interface HeightStats {
  median: number; // дальность до первого обрыва, медиана по лучам, м
  max: number;    // то же, максимум, м
  share: number;  // доля площади круга с уверенной связью (0…1)
}

/** Статистика по каждой высоте расчёта. Площадь взвешивается расстоянием отсчёта (кольца шире к краю). */
export function stats(c: CoverageShown, line: CovLine): HeightStats[] {
  const { samples } = c.res;
  const level = levelAt(c, line);
  return c.heights.map((_, hi) => {
    const fl: number[] = [];
    for (let r = 0; r < c.rays; r++) fl.push(firstLossAt(c, line, hi, r));
    fl.sort((a, b) => a - b);
    let good = 0, total = 0;
    for (let r = 0; r < c.rays; r++) {
      const o = (hi * c.rays + r) * samples;
      for (let k = 1; k < samples; k++) { total += k; if (level(o + k) === 2) good += k; }
    }
    return { median: fl[fl.length >> 1] ?? 0, max: fl[fl.length - 1] ?? 0, share: total ? good / total : 0 };
  });
}

/** Цвет i-й из n высот в палитре длины len: от первого до последнего цвета равномерно. */
export const paletteIndex = (i: number, n: number, len: number) => (n === 1 ? 0 : Math.round((i / (n - 1)) * (len - 1)));

/**
 * Высоты расчёта: всегда droneH; при сравнении — плюс список. Не больше max: лишние — самые далёкие от droneH.
 * По возрастанию (этого требует режим «нужная высота»).
 */
export function coverageHeights(list: readonly number[], droneH: number, compare: boolean, max = COV_MAX_HEIGHTS): number[] {
  if (!compare) return [droneH];
  const others = [...new Set(list)].filter((x) => x !== droneH)
    .sort((a, b) => Math.abs(a - droneH) - Math.abs(b - droneH) || a - b)
    .slice(0, Math.max(0, max - 1));
  return [droneH, ...others].sort((a, b) => a - b);
}

/** Индекс показываемой высоты h в результате: точное совпадение, иначе ближайшая (exact = false — нужен пересчёт). */
export function heightIndex(heights: readonly number[], h: number): { i: number; exact: boolean } {
  const e = heights.indexOf(h);
  if (e >= 0) return { i: e, exact: true };
  let best = 0;
  heights.forEach((v, i) => { if (Math.abs(v - h) < Math.abs(heights[best] - h)) best = i; });
  return { i: best, exact: false };
}

/**
 * Радиогоризонт сам: нужен ли фоновый пересчёт зоны. Без автозапуска или без пульта — нет; сменились пульт,
 * аппаратура или антенны (inputsChanged) — да; сменилась только высота дрона — только если её нет среди посчитанных
 * высот показанного результата (shownHeights: null — результата нет, тогда считать).
 */
export function autoCoverageDue(o: { auto: boolean; hasStation: boolean; inputsChanged: boolean; shownHeights: readonly number[] | null; droneH: number }): boolean {
  if (!o.auto || !o.hasStation) return false;
  if (o.inputsChanged || !o.shownHeights) return true;
  return !heightIndex(o.shownHeights, o.droneH).exact;
}

/** Одинаковые наборы высот (оба по возрастанию). */
export const sameHeights = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
