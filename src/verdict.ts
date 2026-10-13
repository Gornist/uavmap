// Человекочитаемые статусы связи: значки, классы цвета, вердикт пары одной фразой, названия аппаратуры.
// Общие для строки связи, профиля, «Где встать», зоны и меню; без состояния.
import type { LinkStatus, PairResult, LineId } from './radio';
import { STATUS_MAP } from './theme';
import { fixed } from './format';

export const LINE_NAME: Record<LineId, string> = { rc: 'управление', video: 'видео' };

/** Значок статуса: статус передаётся не только цветом. */
export const ICON: Record<LinkStatus, string> = { ok: '✓', weak: '⚠', none: '✕' };
/** Класс цвета статуса. */
export const stCls = (s: LinkStatus) => `status-${s}`;
/** Человеческие названия пресетов (в radio.ts — технические). */
const HUMAN_PRESET: Record<string, string> = {
  elrs24: 'ELRS 2,4 ГГц — управление',
  elrs24_50: 'ELRS 2,4 ГГц — дальний режим',
  elrs900: 'ELRS 868/915 МГц — управление',
  crsf: 'Crossfire 868 МГц — управление',
  lora433: 'LoRa 433 МГц — телеметрия',
  vtx58: 'Аналоговое видео 5,8 ГГц',
  vtx12: 'Аналоговое видео 1,2 ГГц',
  dig58: 'Цифровое видео 5,8 ГГц',
  wifi24: 'Wi-Fi 2,4 ГГц (бытовой дрон)',
};
export const presetName = (p: { id: string; name: string }) => HUMAN_PRESET[p.id] ?? p.name;

/** Вердикт пары одной фразой: «Связь есть», «Видео на грани», «Нет связи». */
export function pairVerdict(p: PairResult): string {
  if (p.rc.belowGround) return 'Дрон ниже склона';
  if (p.status === 'ok') return 'Связь есть';
  const who = p.video ? p.worst : null;
  if (p.status === 'weak') return who === 'video' ? 'Видео на грани' : who === 'rc' ? 'Управление на грани' : 'Связь на грани';
  if (who === 'video' && p.rc.status !== 'none') return 'Нет видео';
  return 'Нет связи';
}

// Цвета статусов на карте (линия связи, маркеры «Где встать») — STATUS_MAP из theme.ts, от темы не зависят.
export const statusCss = (s: LinkStatus) => STATUS_MAP[s];

/** Частота словами: 5800 → «5,8 ГГц», 868 → «868 МГц». */
export const freqName = (mhz: number) =>
  mhz >= 1000 ? `${fixed(mhz / 1000, mhz % 1000 === 0 ? 0 : 1)} ГГц` : `${Math.round(mhz)} МГц`;

/** Нужная высота одной линии: need — минимальная высота для уверенной связи, null — не хватает и на пределе поиска. */
export interface LineNeed { name: string; need: number | null; status: LinkStatus }

/** «Управление — от 300 м», «Видео 5,8 ГГц не добьёт». Всегда с числом или явным «не добьёт». */
export function needText(n: LineNeed): string {
  if (n.need === null) return `${n.name} не добьёт`;
  if (n.need <= 0) return `${n.name} — с любой высоты`;
  return `${n.name} — от ${n.need} м`;
}

/** Нужная высота по каждой линии одной строкой; каждая часть — со значком и цветом текущего статуса линии. */
export const needLinesHtml = (lines: LineNeed[]) =>
  lines.map((l) => `<span class="${stCls(l.status)}">${ICON[l.status]}\u00a0${needText(l)}</span>`).join(' · ');
