// Пульт (точка А), «связь до креста», профиль трассы и подбор места для пилота.
import maplibregl from 'maplibre-gl';
import { S, $, h, map, center, setGeo, fc, line, toast, openSheet, emit, on, progress, escapeHtml } from './app';
import { LatLon, distance, bearing, fmtDist, lonLatToPixel, destination } from './geo';
import { elevationAt, profile, demPlan, demPixelM, demQualityHint, fetchGrid, sampleGrid, sampleRay, DemMissingError, DemGrid } from './elevation';
import { analyzeLink, analyzePair, RANK, minHeightForLink, minHeightsForPair, LinkResult, LinkStatus, PairResult, LineId, PRESETS, presetsFor, RadioParams, radioHorizon, freeSpaceRange } from './radio';
import { drawProfile } from './profileChart';
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

const STATUS_TXT = { ok: 'связь уверенная', weak: 'на грани', none: 'связи нет' } as const;
const STATUS_COL = { ok: '#4fbf72', weak: '#e3b948', none: '#e5484d' } as const;

const fmtM = (m: number) => `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(1)}`;
const LINE_NAME: Record<LineId, string> = { rc: 'управление', video: 'видео' };
const LINE_WORD: Record<LinkStatus, string> = { ok: 'уверенно', weak: 'на грани', none: 'нет связи' };

/** Короткий статус пары для плашки: «связь уверенная», «видео на грани», «управление потеряно». */
function pairText(p: PairResult): string {
  if (!p.video || p.status === 'ok') return STATUS_TXT[p.status];
  if (p.rc.belowGround) return 'ниже рельефа';
  return `${LINE_NAME[p.worst]} ${p.status === 'weak' ? 'на грани' : 'потеряно'}`;
}

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
  const b = openSheet('📡 Пульт — точка А', `
    <div class="kv">
      <div><small>Рельеф</small><b>${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}</b></div>
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

/**
 * Мгновенная реакция на движение карты (без расчёта): линия пульт → прицел следует за крестом
 * приглушённым цветом, в строке — азимут и дальность, запас «…» до прихода расчёта для этой точки.
 */
export function liveFollow() {
  const st = S.station;
  if (!st || stationGround === null) return;
  const a = { lat: st.lat, lon: st.lon }, c = center();
  const dist = distance(a, c);
  if (dist < 5) { setGeo('link', fc()); return; }
  linkLine(a, c, { color: PENDING_COL, dash: 0, op: 0.55 });
  const az = bearing(a, c);
  $('lsStatus').innerHTML = `Аз. ${az.toFixed(1)}° · ${fmtDist(dist)} · ${S.video.enabled ? 'Упр. … · Видео …' : 'запас …'}`;
  const hl = $('hereLink');
  if (!hl.hidden) hl.innerHTML = `До пульта <b>${fmtDist(dist)}</b>, аз. <b>${az.toFixed(0)}°</b><br>Дрон ${S.droneH} м: <b style="color:${PENDING_COL}">…</b>`;
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
    try { r = await calcLink(c, effRadio(), effVideoOrNull(), LIVE_N); } catch (e) {
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
      const { res, vres, pair } = r;
      const losTxt = res.belowGround ? 'дрон ниже рельефа' : res.los ? (res.minClearance >= 0.6 ? 'прямая видимость, Френель чист' : `прямая видимость, Френель закрыт на ${Math.round(Math.min(1, res.fresnelBlocked) * 100)}%`) : 'прямой видимости нет';
      const mTxt = (x: LinkResult) => (x.belowGround ? '—' : fmtM(x.margin) + ' дБ');
      st.innerHTML = vres
        ? `Аз. ${r.az.toFixed(1)}° · ${fmtDist(r.dist)} · Упр. <span class="${res.status}">${mTxt(res)}</span> · Видео <span class="${vres.status}">${mTxt(vres)}</span> · ${losTxt}`
        : `Аз. ${r.az.toFixed(1)}° · ${fmtDist(r.dist)} · запас <span class="${res.status}">${res.belowGround ? '—' : res.margin.toFixed(1) + ' дБ'}</span> · ${losTxt}`;
      hl.hidden = false;
      const detail = res.belowGround ? '(ниже рельефа)' : vres ? `(упр. ${res.margin.toFixed(0)} / видео ${vres.margin.toFixed(0)} дБ)` : `(${res.margin.toFixed(0)} дБ)`;
      hl.innerHTML = `До пульта <b>${fmtDist(r.dist)}</b>, аз. <b>${r.az.toFixed(0)}°</b><br>Дрон ${S.droneH} м: <b style="color:${STATUS_COL[pair.status]}">${pairText(pair)}</b> ${detail}`;
      linkLine(S.station, c, { color: STATUS_COL[pair.status], dash: res.los ? 0 : 1, op: 1 });
    }
  } finally {
    liveBusy = false;
    if (livePending) { livePending = false; updateLive(); }
  }
}

// ---------- Полный профиль ----------

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

function renderProfileSheet(r: LinkCalc) {
  const res = r.res, vres = r.vres, pair = r.pair, hA = r.hA;
  const st = { antH: r.antH };
  const absB = droneAbs(r.groundB, S.droneH, r.groundA);
  const heightFn = (hh: number) => droneAbs(r.groundB, hh, r.groundA);
  const radioEff = effRadio(), videoEff = vres ? effVideo() : null;
  const mins = minHeightsForPair(r.elev, r.dist, hA, heightFn, radioEff, videoEff);
  const mh = (v: number | null) => (v === null ? '&gt;1500' : String(v));
  const rcFade = S.radio.fadeMarginDb;
  const verdict1 = {
    ok: `Связь уверенная: запас ${res.margin.toFixed(1)} дБ при требуемых ${rcFade} дБ`,
    weak: `На грани: запас ${res.margin.toFixed(1)} дБ — меньше желаемых ${rcFade} дБ, возможны срывы`,
    none: `Связи нет: не хватает ${(-res.margin).toFixed(1)} дБ до чувствительности приёмника`,
  }[res.status];
  let verdictText = verdict1;
  if (vres) {
    let tail = '';
    if (RANK[vres.status] < RANK[res.status]) tail = ': картинка пропадёт раньше управления';
    else if (RANK[res.status] < RANK[vres.status]) tail = ': управление слабее видео — дальность ограничивает управление';
    verdictText = `Управление — ${LINE_WORD[res.status]} (${fmtM(res.margin)} дБ), видео — ${LINE_WORD[vres.status]} (${fmtM(vres.margin)} дБ)${tail}`;
  }
  if (res.belowGround) verdictText = 'Связи нет: дрон ниже рельефа в этой точке — увеличьте высоту или переключите отсчёт «над рельефом»';

  const heights = [...new Set([...S.coverage.heights, S.droneH])].sort((a, b) => a - b);
  const colM = (m: LinkResult) => `<td style="color:${STATUS_COL[m.status]}">${m.margin.toFixed(1)}</td>`;
  const hRows = heights.map((hh) => {
    const p = analyzePair(r.elev, r.dist, hA, heightFn(hh), radioEff, videoEff);
    return `<tr data-h="${hh}" class="${hh === S.droneH ? 'sel' : ''}"><td>${hh} м</td><td>${Math.round(heightFn(hh))} м</td><td>${p.rc.los ? 'да' : 'нет'}</td>${p.video ? '' : `<td>${p.rc.diffraction.toFixed(1)}</td>`}${colM(p.rc)}${p.video ? colM(p.video) : ''}</tr>`;
  }).join('');
  const hHead = vres
    ? '<th>Высота</th><th>Абс.</th><th>Видимость</th><th>Упр., дБ</th><th>Видео, дБ</th>'
    : '<th>Высота</th><th>Абс.</th><th>Видимость</th><th>Дифр., дБ</th><th>Запас, дБ</th>';

  const presetRows = (line: LineId) => presetsFor(line).map((p) => {
    const base = line === 'rc' ? S.radio : S.video.radio;
    const radio = withClutter({ ...base, ...p.p }, S.clutter);
    const m = analyzeLink(r.elev, r.dist, hA, absB, radio);
    const mHt = minHeightForLink(r.elev, r.dist, hA, heightFn, radio);
    const cur = line === 'rc' ? S.presetId : S.video.presetId;
    return `<tr data-p="${p.id}" data-line="${line}" class="${p.id === cur ? 'sel' : ''}"><td>${p.name}</td><td>${radio.freqMHz}</td><td style="color:${STATUS_COL[m.status]}">${m.margin.toFixed(1)}</td><td>${mHt === null ? '&gt;1500' : mHt}</td></tr>`;
  }).join('');
  const pHead = '<tr><th>Пресет</th><th>МГц</th><th>Запас, дБ</th><th>Мин. высота, м</th></tr>';
  const presetTables = vres
    ? `<h4 class="hint">Управление — аппаратура на высоте ${S.droneH} м, нажмите, чтобы применить</h4>
    <table class="rt" id="tblP">${pHead}${presetRows('rc')}</table>
    <h4 class="hint">Видео — аппаратура на высоте ${S.droneH} м, нажмите, чтобы применить</h4>
    <table class="rt" id="tblPV">${pHead}${presetRows('video')}</table>`
    : `<h4 class="hint">Аппаратура и частоты на высоте ${S.droneH} м — нажмите, чтобы применить</h4>
    <table class="rt" id="tblP">${pHead}${presetRows('rc')}</table>`;

  // Карточка с двумя значениями: «управление / видео» (одно значение, если видео выключено).
  const two = (label: string, f: (x: LinkResult) => string, plain?: string) =>
    `<div><small>${label}${vres ? ', упр. / видео' : ''}</small><b>${plain ?? (vres ? `${f(res)} / ${f(vres)}` : f(res))}</b></div>`;
  const margCard = (x: LinkResult) => `<span style="color:${STATUS_COL[x.status]}">${x.belowGround ? '—' : x.margin.toFixed(1) + ' дБ'}</span>`;
  const q = demQualityHint(S.station?.lat ?? r.target.lat, r.target.lat);
  const hintHtml = q ? `<p class="hint">${escapeHtml(q)}</p>` : '';
  const hz = radioHorizon(st.antH, absB - r.groundB, S.radio.k);
  const fsr = (p: RadioParams) => fmtDist(freeSpaceRange(p));
  const b = openSheet(`Профиль: пульт → прицел · ${fmtDist(r.dist)}`, `
    <div class="verdict ${pair.status}">${verdictText}</div>
    <canvas id="profileCanvas"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>линия визирования</span><span><i style="background:rgba(227,169,72,.35)"></i>1-я зона Френеля / 60 %${vres ? ` (упр. ${radioEff.freqMHz} МГц)` : ''}</span><span><i style="background:var(--bad)"></i>перекрытие / препятствия</span></div>
    <div class="kv">
      <div><small>Азимут</small><b>${r.az.toFixed(1)}°</b></div>
      <div><small>Дрон абс. / над землёй</small><b>${Math.round(absB)} / ${Math.round(absB - r.groundB)} м</b></div>
      ${vres ? `<div><small>Частоты, МГц: упр. / видео</small><b>${radioEff.freqMHz} / ${videoEff!.freqMHz}</b></div>` : ''}
      ${two('Свободное пр-во', (x) => x.fspl.toFixed(1))}
      ${two('Дифракция на рельефе', (x) => x.diffraction.toFixed(1))}
      ${two('Уровень на приёме', (x) => x.prx.toFixed(1))}
      ${vres ? `<div><small>Запас, дБ: упр. / видео</small><b>${margCard(res)} / ${margCard(vres)}</b></div>` : `<div><small>Запас</small><b>${margCard(res)}</b></div>`}
      <div><small>Мин. зазор / Френель</small><b>${res.belowGround ? '—' : Math.round(res.minClearance * 100) + ' %'}</b></div>
      <div><small>Радиогоризонт</small><b>${fmtDist(hz)}</b></div>
      <div><small>Мин. высота для связи${vres ? ' (обе линии)' : ''}</small><b>${mins.pair === null ? '&gt;1500 м' : mins.pair + ' м'}</b></div>
      ${vres ? `<div><small>Мин. высота: упр. / видео</small><b>${mh(mins.rc)} / ${mh(mins.video)} м</b></div>` : ''}
      ${vres ? `<div><small>Дальность без рельефа: упр. / видео</small><b>${fsr(radioEff)} / ${fsr(videoEff!)}</b></div>` : `<div><small>Дальность без рельефа</small><b>${fsr(radioEff)}</b></div>`}
    </div>
    <h4 class="hint">Высоты дрона (${altModeText()}) — нажмите строку, чтобы выбрать</h4>
    <table class="rt" id="tblH"><tr>${hHead}</tr>${hRows}</table>
    ${presetTables}
    ${hintHtml}<p class="hint">Расчёт: свободное пространство + дифракция на рельефе по ITU-R P.526 (дельта-Буллингтон, P.526-15 §4.5), k = ${S.radio.k.toFixed(2)}. Профиль и линия визирования общие, потери считаются на частоте каждой линии. Местность у пульта: ${CLUTTER_NAME()}. Помехи и диаграммы антенн не моделируются.</p>
  `);
  drawProfile(b.querySelector('#profileCanvas')!, res, { a: `А ${st.antH} м`, b: `Б ${Math.round(absB - r.groundB)} м` });
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
  toast(`${ln === 'video' ? 'Видео' : 'Управление'}: ${p.name}`);
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
    const el = h(`<div class="mk" title="Вариант ${i + 1}" style="color:${STATUS_COL[t.pair.status]}">◆<span class="mk-label">${i + 1}: ${t.res.margin.toFixed(0)} дБ</span></div>`);
    el.addEventListener('click', (e) => { e.stopPropagation(); setStation(t.p); clearBest(); toast('Пульт поставлен в выбранную точку'); });
    bestMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([t.p.lon, t.p.lat]).addTo(map));
  });
  const cell = (x: LinkResult) => `<td style="color:${STATUS_COL[x.status]}">${x.margin.toFixed(1)}</td>`;
  const rows = top.map((t, i) => `<tr data-i="${i}"><td>${i + 1}</td><td>${Math.round(t.gA)} м</td><td>${fmtDist(t.dist)}</td><td>${t.res.los ? 'да' : 'нет'}</td>${cell(t.pair.rc)}${t.pair.video ? cell(t.pair.video) : ''}</tr>`).join('');
  const b = openSheet('Где встать пилоту', `
    <p class="hint">Лучшие точки в радиусе ${fmtDist(radius)} ${S.station ? 'от пульта' : 'от прицела'} для связи с дроном над прицелом на ${S.droneH} м (${altModeText()}), антенна ${antH} м.${vEff ? ' Ранжирование — по худшей из двух линий (управление / видео).' : ''} Нажмите строку или ромб на карте, чтобы перенести пульт.</p>
    <table class="rt"><tr><th>#</th><th>Рельеф</th><th>До прицела</th><th>Видимость</th>${vEff ? '<th>Упр., дБ</th><th>Видео, дБ</th>' : '<th>Запас, дБ</th>'}</tr>${rows}</table>
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
