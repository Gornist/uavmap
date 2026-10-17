// Где по пути к прицелу дрон потеряет связь или упрётся в склон — чистый расчёт по профилю трассы (без карты и DOM).
// Подписи, тексты строки связи и перевод расстояния в координаты — у вызывающего (live.ts).
import { RadioParams, lossAlong } from './radio';

/** wall — склон выше дрона; rc — пропадёт управление; video — видео; both — обе линии почти в одной точке. */
export type LossKind = 'wall' | 'rc' | 'video' | 'both';
/** Событие на пути: d — расстояние от пульта, м. */
export interface LossEvent { d: number; kind: LossKind }

export interface LossOpts {
  /** Событие учитывается, только если оно раньше этой доли трассы (у самого прицела о нём скажет вердикт). */
  earlyFrac?: number;
  /** Потери управления и видео ближе этой доли трассы друг к другу — одно событие «нет связи». */
  mergeFrac?: number;
}

/**
 * События по пути от пульта к прицелу для дрона на абсолютной высоте hB (м над уровнем моря у прицела —
 * та же высота, что у analyzeLink). elev — профиль от пульта (индекс 0) до прицела, dist — длина трассы, hA —
 * абсолютная высота антенны пульта. video = null — одна линия (только управление).
 *
 * Правила: склон выше дрона — отдельное событие (это уже столкновение, а не только связь); потери связи
 * учитываются, только если они раньше склона (после склона дальше лететь некуда); близкие потери управления
 * и видео склеиваются в 'both' (в точке более ранней из двух).
 * Результат — события по возрастанию d и первое из них (ближайшее к пульту).
 */
export function lossPoints(
  elev: ArrayLike<number>, dist: number, hA: number, hB: number,
  rc: RadioParams, video: RadioParams | null, opts: LossOpts = {},
): { events: LossEvent[]; first: LossEvent | null } {
  const limit = dist * (opts.earlyFrac ?? 0.97);
  const merge = dist * (opts.mergeFrac ?? 0.03);
  const early = (d: number | null) => (d !== null && d < limit ? d : null);
  // Склон: первая внутренняя точка профиля выше дрона (концы трассы — пульт и прицел — не в счёт).
  const n = elev.length - 1;
  let wall: number | null = null;
  for (let k = 1; k < n && wall === null; k++) if (elev[k] > hB) wall = (dist * k) / n;
  wall = early(wall);
  const beforeWall = (d: number | null) => (d !== null && (wall === null || d < wall) ? d : null);
  const rcD = beforeWall(early(lossAlong(elev, dist, hA, hB, rc)));
  const vD = video ? beforeWall(early(lossAlong(elev, dist, hA, hB, video))) : null;

  // Порядок от пульта без сортировки (sort в Chrome 68 не обязан быть устойчивым): потери связи строго раньше
  // склона, поэтому склон — последним; управление и видео — по расстоянию (при равенстве управление первым).
  const events: LossEvent[] = [];
  if (rcD !== null && vD !== null && Math.abs(rcD - vD) < merge) events.push({ d: Math.min(rcD, vD), kind: 'both' });
  else {
    if (rcD !== null) events.push({ d: rcD, kind: 'rc' });
    if (vD !== null) events.push({ d: vD, kind: 'video' });
    if (events.length === 2 && events[1].d < events[0].d) events.reverse();
  }
  if (wall !== null) events.push({ d: wall, kind: 'wall' });
  return { events, first: events.length ? events[0] : null };
}
