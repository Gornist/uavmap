// Шторка «Профиль трассы» до точки: вердикт с объяснением (что мешает, что сделать), нужная высота по линиям,
// график, «Подробнее» и сравнение высот и аппаратуры (выбор — только кнопкой «Применить»).
import { S, $, center, toast, openSheet, emit } from './app';
import { km, dB, fixed, escapeHtml } from './format';
import { demQualityHint, DemMissingError } from './elevation';
import { analyzeLink, analyzePair, minHeightForLink, minHeightsForPair, LinkResult, LineId, presetsFor, RadioParams, radioHorizon, freeSpaceRange } from './radio';
import { drawProfile } from './profileChart';
import { coverageHeights } from './coverageStats';
import { CLUTTER, withClutter } from './clutter';
import { ICON, LINE_NAME, stCls, pairVerdict, presetName, needLinesHtml } from './verdict';
import { stationGround, stationGroundFailed, calcLink, LinkCalc, droneAbs, effRadio, effVideo, applyPreset, altModeText, lineNeeds } from './station';

const CLUTTER_NAME = () => (CLUTTER.find((c) => c.id === S.clutter)?.name ?? '—').toLowerCase();

let profRedraw: (() => void) | null = null;
window.addEventListener('uavmap:theme', () => profRedraw?.());

export async function showProfile(target = center()) {
  if (!S.station) { toast('Сначала поставьте пульт'); return; }
  if (stationGround === null) { toast(stationGroundFailed ? 'Нет данных рельефа под пультом' : 'Высота пульта ещё загружается'); return; }
  let r: LinkCalc | null;
  try { r = await calcLink(target); } catch (e) {
    if (e instanceof DemMissingError) { toast('Нет данных рельефа здесь — скачайте район: Меню → Офлайн', 4000); return; }
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
  if (p.rc.belowGround) {
    const n = need === null ? 'выше 1500 м' : `≥ ${need} м`;
    return `На ${S.droneH} м ${altModeText()} дрон в этой точке ниже склона — нужно ${n}. Или считайте высоту «над рельефом» (меню → Расчёт).`;
  }
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

/** Высота дрона над землёй словами: без отрицательных чисел. */
const aboveGround = (m: number) => (m < 0 ? 'ниже склона' : `${Math.round(m)} м`);

function renderProfileSheet(r: LinkCalc) {
  const res = r.res, vres = r.vres, pair = r.pair, hA = r.hA;
  const st = { antH: r.antH };
  const absB = droneAbs(r.groundB, S.droneH, r.groundA);
  const heightFn = (hh: number) => droneAbs(r.groundB, hh, r.groundA);
  const radioEff = effRadio(), videoEff = vres ? effVideo() : null;
  const mins = minHeightsForPair(r.elev, r.dist, hA, heightFn, radioEff, videoEff);
  const mh = (v: number | null) => (v === null ? '&gt; 1500 м' : `${v} м`);
  const worst = pair.worst === 'video' && vres ? vres : res;

  // Высоты для сравнения — список из шторки «Зона» (только чтение; может быть пустым) плюс текущая S.droneH.
  const heights = coverageHeights(S.coverage.heights, S.droneH, true);
  const colM = (m: LinkResult) => `<td class="${stCls(m.status)} num">${m.belowGround ? '—' : dB(m.margin)}</td>`;
  const hRows = heights.map((hh) => {
    const p = analyzePair(r.elev, r.dist, hA, heightFn(hh), radioEff, videoEff);
    const act = hh === S.droneH ? '<td class="muted">сейчас</td>' : `<td><button class="ghost apply" data-h="${hh}">Применить</button></td>`;
    return `<tr class="${hh === S.droneH ? 'sel' : ''}"><td class="num">${hh} м</td><td class="${stCls(p.status)}">${ICON[p.status]} ${pairVerdict(p)}</td>${colM(p.rc)}${p.video ? colM(p.video) : ''}${act}</tr>`;
  }).join('');
  const hHead = (vres ? '<th>Высота</th><th>Связь</th><th>Упр.</th><th>Видео</th>' : '<th>Высота</th><th>Связь</th><th>Запас</th>') + '<th></th>';

  const presetRows = (line: LineId) => presetsFor(line).map((p) => {
    const base = line === 'rc' ? S.radio : S.video.radio;
    const radio = withClutter({ ...base, ...p.p }, S.clutter);
    const m = analyzeLink(r.elev, r.dist, hA, absB, radio);
    const mHt = minHeightForLink(r.elev, r.dist, hA, heightFn, radio);
    const cur = line === 'rc' ? S.presetId : S.video.presetId;
    const act = p.id === cur ? '<td class="muted">сейчас</td>' : `<td><button class="ghost apply" data-p="${p.id}" data-line="${line}">Применить</button></td>`;
    return `<tr class="${p.id === cur ? 'sel' : ''}"><td>${presetName(p)}</td>${colM(m)}<td class="num">${mh(mHt)}</td>${act}</tr>`;
  }).join('');
  const pHead = '<tr><th>Аппаратура</th><th>Запас</th><th>Нужна высота</th><th></th></tr>';
  const presetTables = `<p class="hint">Аппаратура на высоте ${S.droneH} м — «Применить» выберет её для расчёта.</p>`
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
    <p class="prof-need">Нужная высота ${altModeText()}: ${needLinesHtml(lineNeeds(r, radioEff, videoEff, mins))}</p>
    <canvas id="profileCanvas"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>линия связи</span><span><i style="background:var(--fresnel60)"></i>зона Френеля</span><span><i style="background:var(--none)"></i>препятствие</span></div>
    <div class="kv kv-key">
      <div><small>Дальность</small><b class="num">${km(r.dist)}</b></div>
      <div><small>${vres ? 'Высота для обеих линий' : 'Высота для уверенной связи'} (сейчас ${S.droneH} м)</small><b class="num">${mh(mins.pair)}</b></div>
      <div><small>Запас${vres ? ` (${LINE_NAME[pair.worst]})` : ''}</small><b class="num ${stCls(worst.status)}">${worst.belowGround ? '—' : dB(worst.margin)}</b></div>
    </div>
    ${det('more', 'Подробнее', `<div class="kv">
      <div><small>Азимут</small><b class="num">${Math.round(r.az) % 360}°</b></div>
      <div><small>Дрон над землёй / над морем</small><b class="num">${aboveGround(absB - r.groundB)} / ${Math.round(absB)} м</b></div>
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
    ${hintHtml}<p class="hint">Модель: свободное пространство + дифракция на рельефе (ITU-R P.526-15), k = ${fixed(S.radio.k, 2)}, местность у пульта: ${CLUTTER_NAME()}. Лес, здания, помехи и диаграммы антенн не учтены — это оценка, а не гарантия.</p>`)}
    ${det('cmp', 'Сравнить высоты и аппаратуру', `<p class="hint">Высота дрона ${altModeText()}; список высот — в шторке «Зона». «Применить» — считать на этой высоте.</p>
    <table class="rt" id="tblH"><tr>${hHead}</tr>${hRows}</table>
    ${presetTables}`)}
  `);
  b.querySelectorAll<HTMLDetailsElement>('details[data-d]').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) profOpen.add(d.dataset.d!); else profOpen.delete(d.dataset.d!);
  }));
  const cv = b.querySelector<HTMLCanvasElement>('#profileCanvas')!;
  const agl = absB - r.groundB;
  const labels = { a: `Пульт ${st.antH} м`, b: agl < 0 ? 'Дрон ниже склона' : `Дрон ${Math.round(agl)} м` };
  drawProfile(cv, res, labels);
  // Смена темы при открытом профиле перерисовывает холст (CSS меняется сам, пиксели — нет).
  // Один постоянный обработчик хранит только последний профиль — без накопления подписок.
  profRedraw = () => { if (cv.isConnected && !$('sheet').hidden) drawProfile(cv, res, labels); };
  // Выбор высоты/аппаратуры — только явной кнопкой «Применить» (случайный тап по строке ничего не меняет).
  b.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button.apply');
    if (!btn) return;
    if (btn.dataset.h) { S.droneH = +btn.dataset.h; emit('radio'); }
    else if (btn.dataset.p) applyPreset(btn.dataset.p, btn.dataset.line === 'video' ? 'video' : 'rc');
    showProfile(r.target);
  });
}
