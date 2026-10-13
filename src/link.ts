// Пульт (точка А), «связь до креста», профиль трассы и подбор места для пилота.
import maplibregl from 'maplibre-gl';
import { S, $, h, map, center, setGeo, fc, line, toast, openSheet, emit, on, progress, escapeHtml } from './app';
import { LatLon, distance, bearing, lonLatToPixel, destination } from './geo';
import { elevationAt, profile, demPlan, demPixelM, demQualityHint, fetchGrid, sampleGrid, sampleRay, DemMissingError, DemGrid } from './elevation';
import { analyzeLink, analyzePair, RANK, minHeightForLink, minHeightsForPair, LinkResult, LinkStatus, PairResult, LineId, PRESETS, presetsFor, RadioParams, radioHorizon, freeSpaceRange } from './radio';
import { drawProfile } from './profileChart';
import { STATUS_RGB } from './theme';
import { CLUTTER, withClutter } from './clutter';

/** Радиопараметры с учётом местности у пульта — их и нужно передавать в расчёт. */
export const effRadio = () => withClutter(S.radio, S.clutter);
/** То же для линии видео (местность у пульта общая для обеих линий). */
export const effVideo = () => withClutter(S.video.radio, S.clutter);
/** Видео для расчёта: null, если линия выключена. */
export const effVideoOrNull = (): RadioParams | null => (S.video.enabled ? effVideo() : null);
const CLUTTER_NAME = () => (CLUTTER.find((c) => c.id === S.clutter)?.name ?? '—').toLowerCase();
import { formatCoords } from './coords';

export let stationGround: number | null = null;
let stationMarker: maplibregl.Marker | null = null;

const LINE_NAME: Record<LineId, string> = { rc: 'управление', video: 'видео' };

// ---------- Человекочитаемые статусы и числа (общие для строки связи, профиля, зоны и меню) ----------

/** Значок статуса: статус передаётся не только цветом. */
export const ICON: Record<LinkStatus, string> = { ok: '✓', weak: '⚠', none: '✕' };
/** Классы статуса: старые (ok/weak/none) для прежних стилей + семантические status-*. */
export const stCls = (s: LinkStatus) => `${s} status-${s}`;
/** Дальность: до 1 км — целые метры, дальше — км с одним знаком (запятая). */
export function km(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(m < 100000 ? 1 : 0).replace('.', ',')} км`;
}
/** дБ целыми со знаком: «+17 дБ», «−3 дБ». */
export function dB(x: number): string {
  const r = Math.round(x);
  return `${r >= 0 ? '+' : '−'}${Math.abs(r)} дБ`;
}
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
  if (p.rc.belowGround) return 'Дрон ниже рельефа';
  if (p.status === 'ok') return 'Связь есть';
  const who = p.video ? p.worst : null;
  if (p.status === 'weak') return who === 'video' ? 'Видео на грани' : who === 'rc' ? 'Управление на грани' : 'Связь на грани';
  if (who === 'video' && p.rc.status !== 'none') return 'Нет видео';
  return 'Нет связи';
}

// Цвета статусов на карте (линия связи, растр зоны, легенда). Палитра — из theme.ts (STATUS_RGB: на подложке
// цвета от темы не зависят, а --ok/--weak/--none в CSS — это цвета ТЕКСТА на панели). Тема может переопределить
// их CSS-переменными --map-ok/--map-weak/--map-none. Кеш сбрасывается при смене темы.
const MAP_VARS: Record<LinkStatus, string> = { ok: '--map-ok', weak: '--map-weak', none: '--map-none' };
let colCache: Record<LinkStatus, [number, number, number]> | null = null;
function cssRgb(color: string, fb: [number, number, number]): [number, number, number] {
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return fb;
    ctx.fillStyle = `rgb(${fb.join(',')})`;
    ctx.fillStyle = color; // неизвестный формат браузер игнорирует — останется запасной
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch {
    return fb;
  }
}
/** Цвета статусов для карты, [r, g, b]. */
export function statusRgb(): Record<LinkStatus, [number, number, number]> {
  if (colCache) return colCache;
  const cs = getComputedStyle(document.documentElement);
  const pick = (s: LinkStatus) => {
    const x = cs.getPropertyValue(MAP_VARS[s]).trim();
    return x ? cssRgb(x, STATUS_RGB[s]) : STATUS_RGB[s];
  };
  colCache = { ok: pick('ok'), weak: pick('weak'), none: pick('none') };
  return colCache;
}
const statusCss = (s: LinkStatus) => `rgb(${statusRgb()[s].join(',')})`;
/** Подписка на смену темы (theme.ts шлёт 'uavmap:theme' на window; 'themechange' на document — запасной вариант). */
export function onThemeChange(fn: () => void) {
  window.addEventListener('uavmap:theme', fn);
  document.addEventListener('themechange', fn);
}
onThemeChange(() => { colCache = null; if (S.station) updateLive(); });

export function altModeText() {
  return S.altMode === 'takeoff' ? 'над точкой взлёта' : 'над рельефом';
}

/** Абсолютная высота дрона над точкой с рельефом groundB. */
export function droneAbs(groundB: number, hDrone = S.droneH, groundA = stationGround ?? 0) {
  // Отрицательный рельеф не обрезаем: суша ниже уровня моря (Прикаспий) неотличима от батиметрии,
  // а ошибка над морем пессимистична (дрон ниже реального) — для оценки дальности это безопаснее.
  return (S.altMode === 'takeoff' ? groundA : groundB) + hDrone;
}

// Ревизия пульта: каждый перенос/удаление увеличивает её, и ответы,
// запрошенные для прежнего положения, отбрасываются.
let stationRev = 0;
export let stationGroundFailed = false;

async function loadStationGround() {
  const rev = ++stationRev;
  stationGround = null;
  stationGroundFailed = false;
  if (!S.station) return;
  const g = await elevationAt({ lat: S.station.lat, lon: S.station.lon });
  if (rev !== stationRev) return;
  stationGround = g;
  stationGroundFailed = g === null;
  if (stationGroundFailed) toast('Не удалось загрузить высоту пульта — нет данных рельефа');
  emit('station');
}

export async function setStation(p: LatLon, name = 'Пульт') {
  S.station = { lat: p.lat, lon: p.lon, antH: S.station?.antH ?? 2, name };
  const job = loadStationGround();
  renderStation();
  emit('station');
  await job;
}

/** Пульт, восстановленный из сохранённого проекта, — подгрузить его высоту. */
export function initStation() {
  renderStation();
  return loadStationGround();
}

export function removeStation() {
  S.station = null;
  stationRev++;
  stationGround = null;
  stationGroundFailed = false;
  renderStation();
  setGeo('link', fc());
  emit('station');
}

export function renderStation() {
  if (!S.station) { stationMarker?.remove(); stationMarker = null; return; }
  if (!stationMarker) {
    const el = h('<div class="station" title="Пульт">📡</div>');
    el.addEventListener('click', (e) => { e.stopPropagation(); showStationSheet(); });
    stationMarker = new maplibregl.Marker({ element: el }).setLngLat([S.station.lon, S.station.lat]).addTo(map);
  } else stationMarker.setLngLat([S.station.lon, S.station.lat]);
}

function showStationSheet() {
  if (!S.station) return;
  const st = S.station;
  const c = formatCoords(st.lat, st.lon, S.coordFormat);
  const b = openSheet('📡 Пульт', `
    <div class="kv">
      <div><small>Высота места</small><b>${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}</b></div>
      <div><small>Антенна над землёй</small><b>${st.antH} м</b></div>
      <div><small>${c.label}</small><b>${c.short}</b></div>
    </div>
    <div class="row">
      <button class="ghost" id="stGo">Показать</button>
      <button class="ghost" id="stMove">Перенести в прицел</button>
      <button class="danger" id="stDel">Убрать пульт</button>
    </div>`);
  b.querySelector('#stGo')!.addEventListener('click', () => map.flyTo({ center: [st.lon, st.lat] }));
  b.querySelector('#stMove')!.addEventListener('click', () => { setStation(center()); toast('Пульт перенесён'); });
  b.querySelector('#stDel')!.addEventListener('click', () => {
    removeStation(); $('sheet').hidden = true;
  });
}

// ---------- Расчёт трассы ----------

export interface LinkCalc {
  res: LinkResult;            // линия «Управление»
  vres: LinkResult | null;    // линия «Видео» (null — выключена)
  pair: PairResult;
  elev: Float32Array; dist: number; az: number; target: LatLon;
  groundA: number; groundB: number; antH: number; hA: number;
}

/**
 * Расчёт трассы пульт → target. null — пульта нет, его высота не загружена, точки совпадают
 * или пульт успели перенести, пока грузился профиль. При нехватке рельефа — DemMissingError.
 */
export async function calcLink(target: LatLon, radio: RadioParams = effRadio(), video: RadioParams | null = effVideoOrNull(), maxN = 600): Promise<LinkCalc | null> {
  if (!S.station || stationGround === null) return null;
  // Снимок входных данных: после await глобальное состояние могло измениться.
  const rev = stationRev, groundA = stationGround, antH = S.station.antH;
  const a = { lat: S.station.lat, lon: S.station.lon };
  const dist = distance(a, target);
  if (dist < 5) return null;
  const { z, step } = demPlan(a.lat, dist);
  const n = Math.max(16, Math.min(maxN, Math.round(dist / step)));
  const elev = await profile(a, target, n, z);
  if (rev !== stationRev) return null;
  elev[0] = groundA;
  const groundB = elev[n];
  const hA = groundA + antH;
  const pair = analyzePair(elev, dist, hA, droneAbs(groundB, S.droneH, groundA), radio, video);
  return { res: pair.rc, vres: pair.video, pair, elev, dist, az: bearing(a, target), target, groundA, groundB, antH, hA };
}

// ---------- Живая строка «связь до креста» ----------

let liveBusy = false, livePending = false;
export let lastLive: LinkCalc | null = null;
/** Для живой строки хватает 200 отсчётов: запас расходится с полным профилем (до 600) не более чем на 0,2 дБ. */
const LIVE_N = 200;
const PENDING_COL = '#8b949e';
if (import.meta.env.DEV) (window as unknown as { __liveStats: { calcs: number } }).__liveStats = { calcs: 0 };

const linkLine = (a: S_Station, c: LatLon, props: Record<string, unknown>) =>
  setGeo('link', fc([line([[a.lon, a.lat], [c.lon, c.lat]], props)]));
type S_Station = { lat: number; lon: number };

/** Минимальная высота дрона (в текущем режиме отсчёта), при которой обе линии держат свой запас. null — не хватает и на 1500 м. */
function needHeight(r: LinkCalc, radio: RadioParams = effRadio(), video: RadioParams | null = r.vres ? effVideo() : null): number | null {
  const fn = (hh: number) => droneAbs(r.groundB, hh, r.groundA);
  return minHeightsForPair(r.elev, r.dist, r.hA, fn, radio, video).pair;
}

/**
 * Хвост вердикта: «— нужно ≥ 410 м», если уверенную связь даёт подъём дрона. need = null — не даёт и 1500 м:
 * для «на грани» хвоста нет (высота не поможет), для «нет связи» — так и пишем.
 */
function needTail(p: PairResult, need: number | null): string {
  if (p.status === 'ok') return '';
  if (need !== null) return need > S.droneH ? ` — нужно ≥ ${need} м` : '';
  if (p.rc.belowGround) return ' — поднимите дрон';
  return p.status === 'none' ? ' — не хватит и на 1500 м' : '';
}

/** Вторая строка: запасы линий и азимут. */
function subLine(r: LinkCalc): string {
  const m = (x: LinkResult) => `<span class="${stCls(x.status)} num">${x.belowGround ? '—' : dB(x.margin)}</span>`;
  const lines = r.vres ? `Упр. ${m(r.res)} · Видео ${m(r.vres)}` : `Запас ${m(r.res)}`;
  return `${lines} · аз. <span class="num">${Math.round(r.az) % 360}°</span>`;
}

/**
 * Мгновенная реакция на движение карты (без расчёта): линия пульт → прицел следует за крестом
 * приглушённым цветом, в строке — дальность и азимут, вердикт «…» до прихода расчёта для этой точки.
 */
export function liveFollow() {
  const st = S.station;
  if (!st || stationGround === null) return;
  const a = { lat: st.lat, lon: st.lon }, c = center();
  const dist = distance(a, c);
  if (dist < 5) { setGeo('link', fc()); return; }
  linkLine(a, c, { color: PENDING_COL, dash: 0, op: 0.55 });
  const az = Math.round(bearing(a, c)) % 360;
  $('lsStatus').innerHTML = `<div class="verdict-big muted">Считаю… · <span class="num">${km(dist)}</span></div><div class="ls-sub muted">аз. <span class="num">${az}°</span></div>`;
  const hl = $('hereLink');
  if (!hl.hidden) hl.innerHTML = `До пульта <b class="num">${km(dist)}</b> · <span class="muted">считаю…</span>`;
}

export async function updateLive() {
  if (!S.station) { setGeo('link', fc()); $('hereLink').hidden = true; return; }
  // Очередь не копим: пока идёт расчёт, помним только факт «нужен ещё один» — он возьмёт текущий прицел.
  if (liveBusy) { livePending = true; return; }
  liveBusy = true;
  const st = $('lsStatus'), hl = $('hereLink');
  try {
    const c = center();
    if (import.meta.env.DEV) (window as unknown as { __liveStats: { calcs: number } }).__liveStats.calcs++;
    let r: LinkCalc | null;
    const radio = effRadio(), video = effVideoOrNull();
    try { r = await calcLink(c, radio, video, LIVE_N); } catch (e) {
      if (!(e instanceof DemMissingError)) throw e;
      if (distance(center(), c) > 2) return; // прицел уже ушёл — устаревший ответ
      lastLive = null;
      st.textContent = e.message; hl.hidden = true; setGeo('link', fc());
      return;
    }
    if (!S.station) { setGeo('link', fc()); hl.hidden = true; return; }
    // Ревизия цели: пока считали, прицел мог уйти — расчёт для прежней точки не применяем
    // (новый запрос уже запланирован движением карты).
    if (distance(center(), c) > 2) return;
    lastLive = r;
    if (!r) {
      st.innerHTML = stationGroundFailed ? 'Нет данных рельефа под пультом' : stationGround === null ? 'Загружаю высоту пульта…' : 'Прицел на пульте — сдвиньте карту';
      setGeo('link', fc()); hl.hidden = true;
    } else {
      const { res, pair } = r;
      const need = pair.status === 'ok' ? 0 : needHeight(r, radio, video);
      const v = `${ICON[pair.status]} ${pairVerdict(pair)}`;
      st.innerHTML = `<div class="verdict-big ${stCls(pair.status)}">${v} · <span class="num">${km(r.dist)}</span><span class="ls-need">${needTail(pair, need)}</span></div><div class="ls-sub muted">${subLine(r)}</div>`;
      hl.hidden = false;
      hl.innerHTML = `До пульта <b class="num">${km(r.dist)}</b> · <b class="${stCls(pair.status)}">${v}</b>`;
      linkLine(S.station, c, { color: statusCss(pair.status), dash: res.los ? 0 : 1, op: 1 });
    }
  } finally {
    liveBusy = false;
    if (livePending) { livePending = false; updateLive(); }
  }
}

// ---------- Полный профиль ----------

let profRedraw: (() => void) | null = null;
window.addEventListener('uavmap:theme', () => profRedraw?.());

export async function showProfile(target = center()) {
  if (!S.station) { toast('Сначала поставьте пульт'); return; }
  if (stationGround === null) { toast(stationGroundFailed ? 'Нет данных рельефа под пультом' : 'Высота пульта ещё загружается'); return; }
  let r: LinkCalc | null;
  try { r = await calcLink(target); } catch (e) {
    if (e instanceof DemMissingError) { toast(e.message); return; }
    throw e;
  }
  if (!r) { if (S.station) toast('Прицел совпадает с пультом или пульт перенесён'); return; }
  renderProfileSheet(r);
}

/** Главное препятствие: точка, глубже всего закрывающая линию связи (или ближе всех к ней подходящая). */
function obstacle(res: LinkResult): { at: number; kind: 'block' | 'fresnel' } | null {
  const n = res.d.length - 1;
  if (n < 2) return null;
  if (!res.los) {
    let bi = 1, best = -Infinity;
    for (let i = 1; i < n; i++) { const pen = res.ground[i] - res.los_h[i]; if (pen > best) { best = pen; bi = i; } }
    return { at: res.d[bi], kind: 'block' };
  }
  if (res.minClearance < 0.6) {
    let bi = 1, best = Infinity;
    for (let i = 1; i < n; i++) if (res.fz[i] > 0) { const q = (res.los_h[i] - res.ground[i]) / res.fz[i]; if (q < best) { best = q; bi = i; } }
    return { at: res.d[bi], kind: 'fresnel' };
  }
  return null;
}

/** Объяснение вердикта одной-двумя фразами: что мешает и что сделать. */
function explain(r: LinkCalc, need: number | null): string {
  const p = r.pair;
  if (p.rc.belowGround) return `На высоте ${S.droneH} м дрон в этой точке оказывается ниже склона. Поднимите его или считайте высоту «над рельефом» (меню → Расчёт).`;
  const w = p.worst === 'video' && r.vres ? r.vres : r.res;
  const ob = obstacle(w);
  const near = (at: number) => (at < 300 ? 'рядом с пультом' : at > r.dist - 300 ? 'у цели' : `на ${km(at)} от пульта`);
  const parts: string[] = [];
  if (ob?.kind === 'block') parts.push(`Хребет ${near(ob.at)} закрывает обзор${p.status === 'ok' ? ', но сигнал его огибает' : ''}.`);
  else if (ob) parts.push(`Рельеф ${near(ob.at)} почти касается линии связи — сигнал ослаблен.`);
  else parts.push(p.status === 'ok' ? 'Между пультом и дроном препятствий нет.' : p.status === 'weak' ? 'Препятствий нет, но для такой дальности сигнал слабоват.' : 'Препятствий нет, но на такую дальность не хватает мощности.');
  if (p.status !== 'ok') {
    if (need === null) parts.push(p.status === 'weak' ? 'Высота не поможет — подойдите ближе или возьмите аппаратуру мощнее.' : 'Даже на 1500 м уверенной связи не будет — подойдите ближе или возьмите аппаратуру мощнее.');
    else if (need > S.droneH) parts.push(`Поднимитесь до ${need} м или подойдите ближе.`);
    else parts.push('Подойдите ближе.');
    if (p.status === 'weak' && p.worst === 'video' && r.vres && r.res.status === 'ok') parts.push('Управление держится, картинка пропадёт раньше.');
  }
  return parts.join(' ');
}

// Раскрытые блоки «Подробнее» в профиле переживают перерисовку (выбор высоты/аппаратуры из таблицы).
const profOpen = new Set<string>();

function renderProfileSheet(r: LinkCalc) {
  const res = r.res, vres = r.vres, pair = r.pair, hA = r.hA;
  const st = { antH: r.antH };
  const absB = droneAbs(r.groundB, S.droneH, r.groundA);
  const heightFn = (hh: number) => droneAbs(r.groundB, hh, r.groundA);
  const radioEff = effRadio(), videoEff = vres ? effVideo() : null;
  const mins = minHeightsForPair(r.elev, r.dist, hA, heightFn, radioEff, videoEff);
  const mh = (v: number | null) => (v === null ? '&gt; 1500 м' : `${v} м`);
  const worst = pair.worst === 'video' && vres ? vres : res;

  const heights = [...new Set([...S.coverage.heights, S.droneH])].sort((a, b) => a - b);
  const colM = (m: LinkResult) => `<td class="${stCls(m.status)} num">${m.belowGround ? '—' : dB(m.margin)}</td>`;
  const hRows = heights.map((hh) => {
    const p = analyzePair(r.elev, r.dist, hA, heightFn(hh), radioEff, videoEff);
    return `<tr data-h="${hh}" class="${hh === S.droneH ? 'sel' : ''}"><td class="num">${hh} м</td><td class="${stCls(p.status)}">${ICON[p.status]} ${pairVerdict(p)}</td>${colM(p.rc)}${p.video ? colM(p.video) : ''}</tr>`;
  }).join('');
  const hHead = vres ? '<th>Высота</th><th>Связь</th><th>Упр.</th><th>Видео</th>' : '<th>Высота</th><th>Связь</th><th>Запас</th>';

  const presetRows = (line: LineId) => presetsFor(line).map((p) => {
    const base = line === 'rc' ? S.radio : S.video.radio;
    const radio = withClutter({ ...base, ...p.p }, S.clutter);
    const m = analyzeLink(r.elev, r.dist, hA, absB, radio);
    const mHt = minHeightForLink(r.elev, r.dist, hA, heightFn, radio);
    const cur = line === 'rc' ? S.presetId : S.video.presetId;
    return `<tr data-p="${p.id}" data-line="${line}" class="${p.id === cur ? 'sel' : ''}"><td>${presetName(p)}</td>${colM(m)}<td class="num">${mh(mHt)}</td></tr>`;
  }).join('');
  const pHead = '<tr><th>Аппаратура</th><th>Запас</th><th>Нужна высота</th></tr>';
  const presetTables = `<p class="hint">Аппаратура на высоте ${S.droneH} м — нажмите строку, чтобы выбрать.</p>`
    + (vres ? '<h4 class="hint">Управление</h4>' : '') + `<table class="rt" id="tblP">${pHead}${presetRows('rc')}</table>`
    + (vres ? `<h4 class="hint">Видео</h4><table class="rt" id="tblPV">${pHead}${presetRows('video')}</table>` : '');

  // Карточка с двумя значениями: «управление / видео» (одно значение, если видео выключено).
  const two = (label: string, f: (x: LinkResult) => string) =>
    `<div><small>${label}${vres ? ', упр. / видео' : ''}</small><b class="num">${vres ? `${f(res)} / ${f(vres)}` : f(res)}</b></div>`;
  const q = demQualityHint(S.station?.lat ?? r.target.lat, r.target.lat);
  const hintHtml = q ? `<p class="hint">${escapeHtml(q)}</p>` : '';
  const hz = radioHorizon(st.antH, absB - r.groundB, S.radio.k);
  const fsr = (p: RadioParams) => km(freeSpaceRange(p));
  const int = (x: number) => String(Math.round(x));
  const det = (id: string, title: string, inner: string) =>
    `<details class="details" data-d="${id}"${profOpen.has(id) ? ' open' : ''}><summary>${title}</summary>${inner}</details>`;

  const b = openSheet(`Профиль до прицела · ${km(r.dist)}`, `
    <div class="verdict verdict-big ${stCls(pair.status)}">${ICON[pair.status]} ${pairVerdict(pair)}</div>
    <p class="verdict-why">${explain(r, mins.pair)}</p>
    <canvas id="profileCanvas"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>линия связи</span><span><i style="background:rgba(227,169,72,.35)"></i>зона Френеля</span><span><i style="background:var(--bad)"></i>препятствие</span></div>
    <div class="kv kv-key">
      <div><small>Дальность</small><b class="num">${km(r.dist)}</b></div>
      <div><small>Высота для уверенной связи (сейчас ${S.droneH} м)</small><b class="num">${mh(mins.pair)}</b></div>
      <div><small>Запас${vres ? ` (${LINE_NAME[pair.worst]})` : ''}</small><b class="num ${stCls(worst.status)}">${worst.belowGround ? '—' : dB(worst.margin)}</b></div>
    </div>
    ${det('more', 'Подробнее', `<div class="kv">
      <div><small>Азимут</small><b class="num">${Math.round(r.az) % 360}°</b></div>
      <div><small>Дрон над землёй / над морем</small><b class="num">${Math.round(absB - r.groundB)} / ${Math.round(absB)} м</b></div>
      ${vres ? `<div><small>Частоты, МГц: упр. / видео</small><b class="num">${radioEff.freqMHz} / ${videoEff!.freqMHz}</b></div>` : `<div><small>Частота</small><b class="num">${radioEff.freqMHz} МГц</b></div>`}
      ${two('Запас, дБ', (x) => (x.belowGround ? '—' : dB(x.margin).replace(' дБ', '')))}
      ${two('Потери в свободном пространстве, дБ', (x) => int(x.fspl))}
      ${two('Потери на рельефе (дифракция), дБ', (x) => int(x.diffraction))}
      ${two('Уровень приёма, дБм', (x) => int(x.prx))}
      <div><small>Зона Френеля свободна</small><b class="num">${res.belowGround ? '—' : Math.round(Math.max(0, Math.min(1, res.minClearance)) * 100) + ' %'}</b></div>
      <div><small>Радиогоризонт</small><b class="num">${km(hz)}</b></div>
      ${vres ? `<div><small>Нужная высота: упр. / видео</small><b class="num">${mh(mins.rc)} / ${mh(mins.video)}</b></div>` : ''}
      <div><small>Дальность без рельефа${vres ? ', упр. / видео' : ''}</small><b class="num">${vres ? `${fsr(radioEff)} / ${fsr(videoEff!)}` : fsr(radioEff)}</b></div>
    </div>
    ${hintHtml}<p class="hint">Модель: свободное пространство + дифракция на рельефе (ITU-R P.526-15), k = ${S.radio.k.toFixed(2)}, местность у пульта: ${CLUTTER_NAME()}. Лес, здания, помехи и диаграммы антенн не учтены — это оценка, а не гарантия.</p>`)}
    ${det('cmp', 'Сравнить высоты и аппаратуру', `<p class="hint">Высота дрона ${altModeText()} — нажмите строку, чтобы выбрать.</p>
    <table class="rt" id="tblH"><tr>${hHead}</tr>${hRows}</table>
    ${presetTables}`)}
  `);
  b.querySelectorAll<HTMLDetailsElement>('details[data-d]').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) profOpen.add(d.dataset.d!); else profOpen.delete(d.dataset.d!);
  }));
  const cv = b.querySelector<HTMLCanvasElement>('#profileCanvas')!;
  const labels = { a: `Пульт ${st.antH} м`, b: `Дрон ${Math.round(absB - r.groundB)} м` };
  drawProfile(cv, res, labels);
  // Смена темы при открытом профиле перерисовывает холст (CSS меняется сам, пиксели — нет).
  // Один постоянный обработчик хранит только последний профиль — без накопления подписок.
  profRedraw = () => { if (cv.isConnected && !$('sheet').hidden) drawProfile(cv, res, labels); };
  b.querySelector('#tblH')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-h]') as HTMLElement | null;
    if (!tr) return;
    S.droneH = +tr.dataset.h!; ($('inDrone') as HTMLInputElement).value = String(S.droneH);
    emit('radio'); showProfile(r.target);
  });
  b.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-p]') as HTMLElement | null;
    if (!tr) return;
    applyPreset(tr.dataset.p!, tr.dataset.line === 'video' ? 'video' : 'rc'); showProfile(r.target);
  });
}

/** Применить пресет к линии (по умолчанию: видео-пресеты — к видео, остальные — к управлению). */
export function applyPreset(id: string, line?: LineId) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  const ln: LineId = line ?? (p.kind === 'video' ? 'video' : 'rc');
  if (ln === 'video') { Object.assign(S.video.radio, p.p); S.video.presetId = id; S.video.enabled = true; }
  else { Object.assign(S.radio, p.p); S.presetId = id; }
  emit('radio');
  toast(`${ln === 'video' ? 'Видео' : 'Управление'}: ${presetName(p)}`);
}

// ---------- «Где встать»: лучшее место для пульта, чтобы дотянуться до прицела ----------

let bestMarkers: maplibregl.Marker[] = [];
export function clearBest() { bestMarkers.forEach((m) => m.remove()); bestMarkers = []; }

export async function findBestSpot(radius: number) {
  clearBest();
  const target = center();
  const antH = S.station?.antH ?? 2;
  const N = 20, cand: LatLon[] = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const dx = ((i / N) * 2 - 1) * radius, dy = ((j / N) * 2 - 1) * radius;
    const rr = Math.hypot(dx, dy);
    if (rr > radius) continue;
    cand.push(destination(target, (Math.atan2(dx, dy) * 180) / Math.PI, rr));
  }
  // Ищем место вокруг текущего пульта, если он есть, иначе — вокруг прицела (полёт «туда и обратно»).
  const base = S.station ? { lat: S.station.lat, lon: S.station.lon } : target;
  const around = cand.map((p) => destination(base, bearing(target, p), distance(target, p)));
  const far = Math.max(...around.map((p) => distance(p, target)));
  const tilesFor = (zz: number) => {
    const pts = [...around, target].map((p) => lonLatToPixel(p.lon, p.lat, zz));
    const xs = pts.map((p) => p[0] / 256), ys = pts.map((p) => p[1] / 256);
    return (Math.floor(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 1) * (Math.floor(Math.max(...ys)) - Math.floor(Math.min(...ys)) + 1);
  };
  const { z, step } = demPlan(target.lat, far, tilesFor, 100);
  const pad = Math.ceil(step / demPixelM(target.lat, z)) + 2;
  progress(0.2, 'Загружаю рельеф…');
  let grid: DemGrid;
  try { grid = await fetchGrid([...around, target], z, pad); } catch (e) {
    progress(null);
    if (e instanceof DemMissingError) { toast(e.message); return; }
    throw e;
  }
  progress(0.6, 'Перебираю точки…');
  const [tx, ty] = lonLatToPixel(target.lon, target.lat, z);
  const gT = sampleGrid(grid, tx, ty);
  const rcEff = effRadio(), vEff = effVideoOrNull();
  const scored = around.map((p) => {
    const dist = distance(p, target);
    const n = Math.max(16, Math.min(400, Math.round(dist / step)));
    const ray = new Float64Array(n + 1), elev = new Float32Array(n + 1);
    sampleRay(grid, p.lat, p.lon, bearing(p, target), dist / n, n + 1, ray);
    elev.set(ray);
    elev[n] = gT;
    const gA = elev[0];
    const pair = analyzePair(elev, Math.max(dist, 1), gA + antH, droneAbs(gT, S.droneH, gA), rcEff, vEff);
    return { p, pair, res: pair.worst === 'video' && pair.video ? pair.video : pair.rc, gA, dist };
  // Сначала статус пары (обе линии есть > на грани > нет), потом запас худшей линии сверх порога.
  }).sort((a, b) => RANK[b.pair.status] - RANK[a.pair.status] || b.pair.score - a.pair.score);
  const top: typeof scored = [];
  for (const s of scored) {
    if (top.every((t) => distance(t.p, s.p) > radius / 4)) top.push(s);
    if (top.length >= 5) break;
  }
  progress(null);
  top.forEach((t, i) => {
    const el = h(`<div class="mk" title="Вариант ${i + 1}" style="color:${statusCss(t.pair.status)}">◆<span class="mk-label">${i + 1} ${ICON[t.pair.status]}</span></div>`);
    el.addEventListener('click', (e) => { e.stopPropagation(); setStation(t.p); clearBest(); toast('Пульт поставлен в выбранную точку'); });
    bestMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([t.p.lon, t.p.lat]).addTo(map));
  });
  const rows = top.map((t, i) => `<tr data-i="${i}"><td class="num">${i + 1}</td><td class="${stCls(t.pair.status)}">${ICON[t.pair.status]} ${pairVerdict(t.pair)}</td><td class="num">${km(t.dist)}</td><td class="num ${stCls(t.res.status)}">${dB(t.res.margin)}</td></tr>`).join('');
  const b = openSheet('Где встать пилоту', `
    <p class="hint">Лучшие места в ${km(radius)} ${S.station ? 'от пульта' : 'от прицела'} для дрона над прицелом на ${S.droneH} м. Нажмите строку или ромб на карте — пульт переедет туда.</p>
    <table class="rt"><tr><th>#</th><th>Связь</th><th>До прицела</th><th>Запас</th></tr>${rows}</table>
    <div class="row"><button class="ghost" id="bsClear">Убрать варианты</button></div>`, clearBest);
  b.querySelector('table')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
    if (!tr) return;
    const t = top[+tr.dataset.i!];
    map.flyTo({ center: [t.p.lon, t.p.lat] });
    setStation(t.p);
  });
  b.querySelector('#bsClear')!.addEventListener('click', () => { clearBest(); $('sheet').hidden = true; });
}

on('station', () => { renderStation(); updateLive(); });
on('radio', () => updateLive());
export { escapeHtml };
