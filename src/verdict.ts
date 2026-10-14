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

/** Нужные высоты трассы: управление, видео (null — не добьёт; undefined — видео выключено) и обе линии сразу. */
export interface HeightNeeds { rc: number | null; video?: number | null; pair: number | null }
/** Статус линий на текущей высоте: «не добьёт» (none) и «на грани» (weak) — разные советы. */
export interface LinesNow { rc: LinkStatus; video?: LinkStatus }

/** Предел поиска нужной высоты (minHeightForLink): «не добьёт» значит «не добьёт до этой высоты». */
const SEARCH_MAX = 1500;

/**
 * Одна подсказка-действие для высоты дрона h: что будет, если подняться или можно ли снизиться.
 * «Поднимите до 480 м — будет и видео», «Связь держится; можно снизиться до 210 м», «Даже на 1500 м …».
 */
export function heightHint(h: number, needs: HeightNeeds, videoName = 'Видео', now?: LinesNow): string {
  // Поиск нужной высоты ограничен 1500 м: выше этого линия может работать — тогда её «нужная» — текущая высота.
  const n = { ...needs };
  const both = now && now.rc === 'ok' && (now.video === undefined || now.video === 'ok');
  if (n.rc === null && now?.rc === 'ok') n.rc = h;
  if (n.video === null && now?.video === 'ok') n.video = h;
  if (n.pair === null && both) n.pair = h;
  const lower = (to: number, what: string) => (to <= 0 ? `${what} на любой высоте` : to < h ? `${what}; можно снизиться до ${to} м` : what);
  const top = `${SEARCH_MAX} м`;
  if (n.rc === null) {
    return now?.rc === 'weak' ? `Даже на ${top} управление на грани — подойдите ближе`
      : `Управление не добьёт даже на ${top} — подойдите ближе или нажмите «Где встать»`;
  }
  if (n.video === undefined) return h < n.rc ? `Поднимите до ${n.rc} м — появится связь` : lower(n.rc, 'Связь держится');
  const vn = videoName.charAt(0).toLowerCase() + videoName.slice(1); // «видео 5,8 ГГц» — единицы не трогаем
  const noVideo = now?.video === 'weak' ? `${vn} на грани даже на ${top}` : `${vn} не добьёт даже на ${top}`;
  if (h < n.rc) {
    if (n.pair === null) return `Поднимите до ${n.rc} м — появится управление; ${noVideo}`;
    return n.pair > n.rc ? `Поднимите до ${n.rc} м — появится управление, до ${n.pair} м — и видео` : `Поднимите до ${n.rc} м — появится связь`;
  }
  if (n.pair === null) return `${noVideo.charAt(0).toUpperCase()}${noVideo.slice(1)} — подойдите ближе`;
  if (h < n.pair) return `Поднимите до ${n.pair} м — будет и видео`;
  return lower(n.pair, 'Управление и видео держатся');
}

/** Высота места под прицелом словами: относительно пульта, если он стоит, иначе — над уровнем моря. */
export function hereText(here: number | null, station: number | null, hasStation: boolean): string {
  if (here === null) return 'Нет данных рельефа';
  if (!hasStation || station === null) return `Рельеф ${Math.round(here)} м`;
  const d = Math.round(here - station);
  if (Math.abs(d) < 3) return 'Вровень с пультом';
  return d > 0 ? `На ${d} м выше пульта` : `На ${-d} м ниже пульта`;
}
