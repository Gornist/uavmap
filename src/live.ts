// Строка связи вверху карты: пока пульта нет — «Пульт здесь / По GPS»; с пультом — вердикт до прицела,
// одна подсказка по высоте («Поднимите до 480 м — будет и видео»), мелко запасы и азимут; нажатие на строку — профиль трассы.
// Данные для высотомера (связь на каждой высоте) и планировщик пересчёта при движении карты.
// Линия пульт → прицел на карте — linkLayer.ts, точки потери связи по пути — lossPoints.ts.
import { S, $, map, center, toast, on, emit } from './app';
import { inBeam, rumb } from './antenna';
import { km, dB, escapeHtml } from './format';
import { LatLon, distance, bearing, interpolate } from './geo';
import { DemMissingError } from './elevation';
import { LinkResult, PairResult, RadioParams, analyzePair, minHeightsForPair } from './radio';
import { LossKind, lossPoints } from './lossPoints';
import { PENDING_COL, setLink, linkLine, setLoss, linkGhost, hideGhost, onLinkToggle } from './linkLayer';
import { ICON, stCls, pairVerdict, statusCss, heightHint, HeightNeeds, freqName } from './verdict';
import { setStation, stationGround, stationGroundFailed, calcLink, heightFnFor, LinkCalc, activeAntennaLines } from './station';
import { setAltData, setAltPreview } from './altimeter';
import { AltLevel } from './altScale';
import { showProfile } from './lazy';
import { openOfflineSheet, offlineCover } from './offline';

let liveBusy = false, livePending = false;
/** Для живой строки хватает 200 отсчётов: запас расходится с полным профилем (до 600) не более чем на 0,2 дБ. */
const LIVE_N = 200;

let moving = false; // карта движется (между первым move и moveend)

/** Третья строка (мелко): запасы линий и азимут. Прочерк вместо служебного запаса «дрон ниже склона». */
function subLine(pair: PairResult, az: number, loss: string): string {
  const m = (x: LinkResult) => `<span class="${stCls(x.status)} num">${x.belowGround ? '—' : dB(x.margin)}</span>`;
  const lines = pair.video ? `Упр. ${m(pair.rc)} · Видео ${m(pair.video)}` : `Запас ${m(pair.rc)}`;
  return `${lines} · аз. <span class="num">${Math.round(az) % 360}°</span>${loss}${offlineNote()}`;
}

/** Прицел вне луча направленной антенны на земле — какой именно (управление / видео) и кнопка развернуть их на прицел. */
function aimNote(az: number): string {
  const out = activeAntennaLines().filter((x) => !inBeam(S.antenna[x], az, S.antenna[x].heading));
  if (!out.length) return '';
  const name = { rc: 'управления', video: 'видео' };
  const a = Math.round(az) % 360;
  const what = out.map((x) => `${name[x]} — аз. ${Math.round(S.antenna[x].heading)}° ${rumb(S.antenna[x].heading)}`).join(', ');
  return `<div class="ls-aim"><span class="status-weak">Прицел (аз. ${a}° ${rumb(a)}) вне луча антенны ${what}</span><button class="ghost" data-act="aim">${out.length > 1 ? 'Повернуть обе' : 'Повернуть'}</button></div>`;
}

/** Готовность к полёту без сети: трасса внутри скачанного района или нет (молчим, если районов нет вовсе). */
function offlineNote(): string {
  const st = S.station, tg = last?.r.target;
  if (!st || !tg) return '';
  const c = offlineCover([st, tg]);
  return c === 'yes' ? ' · <span class="status-ok">офлайн ✓</span>' : c === 'no' ? ' · вне скачанных районов' : '';
}

/** Подпись метки на линии и начало фразы в строке связи для события по пути. */
const LOSS_LABEL: Record<LossKind, string> = { wall: 'склон выше дрона', both: 'нет связи', rc: 'нет управления', video: 'нет видео' };
const LOSS_TEXT: Record<LossKind, string> = { wall: 'склон выше дрона на', both: 'связь пропадёт на', rc: 'управление пропадёт на', video: 'видео пропадёт на' };

/**
 * Где по пути к прицелу пропадёт связь (дрон летит к нему на высоте hh): метки на линии и строка для строки связи.
 * Только если это случится раньше прицела — у самого прицела об этом и так говорит вердикт.
 */
function lossInfo(l: NonNullable<typeof last>, hh: number): { features: GeoJSON.Feature[]; text: string } {
  const st = S.station;
  if (!st) return { features: [], text: '' };
  const { events, first } = lossPoints(l.r.elev, l.r.dist, l.r.hA, heightFnFor(l.r)(hh), l.radio, l.video);
  const features = events.map((p): GeoJSON.Feature => {
    const q = interpolate(st, l.r.target, p.d / l.r.dist);
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { label: `${LOSS_LABEL[p.kind]} · ${km(p.d)}`, d: p.d } };
  });
  const text = first ? ` · <span class="status-none">${LOSS_TEXT[first.kind]} <span class="num">${km(first.d)}</span></span>` : '';
  return { features, text };
}

/** Последний расчёт трассы — для предпросмотра высоты на высотомере без нового профиля. */
let last: { r: LinkCalc; radio: RadioParams; video: RadioParams | null; needs: HeightNeeds } | null = null;

/** Связь на высоте hh для расчёта l (рельеф трассы тот же, меняется только высота дрона). */
const pairAt = (l: NonNullable<typeof last>, hh: number) => analyzePair(l.r.elev, l.r.dist, l.r.hA, heightFnFor(l.r)(hh), l.radio, l.video);

/** Вердикт, подсказка по высоте, запасы; линия на карте — цветом статуса. */
function renderStrip(l: NonNullable<typeof last>, pair: PairResult, hh: number) {
  const vName = l.video ? `Видео ${freqName(l.video.freqMHz)}` : undefined;
  const loss = lossInfo(l, hh); // доли миллисекунды — и при перетаскивании высотомера
  $('lsStatus').innerHTML = `<div class="ls-verdict ${stCls(pair.status)}">${ICON[pair.status]} ${pairVerdict(pair)} · <span class="num">${km(l.r.dist)}</span><span class="ls-more" aria-hidden="true">›</span></div>`
    + `<div class="ls-need">${escapeHtml(heightHint(hh, l.needs, vName, { rc: pair.rc.status, video: pair.video?.status }))}</div><div class="ls-sub muted">${subLine(pair, l.r.az, loss.text)}</div>`
    + aimNote(l.r.az);
  if (S.station) linkLine(S.station, l.r.target, { color: statusCss(pair.status), dash: pair.rc.los ? 0 : 1, op: 1 });
  setLoss(loss.features);
}

/**
 * Данные высотомера: какая связь на каждой высоте; склон — если дрон оказался бы ниже рельефа у прицела;
 * needs — те же нужные высоты, что в подсказке строки связи (подпись «связь от N м» у шкалы совпадает с ней).
 */
function altData(l: NonNullable<typeof last>) {
  const fn = heightFnFor(l.r);
  const level = (hh: number): AltLevel => (fn(hh) < l.r.groundB - 0.05 ? 'ground' : pairAt(l, hh).status);
  const slope = Math.max(0, l.r.groundB - fn(0)); // высота склона над точкой отсчёта
  const marks = [l.needs.rc, l.needs.video, l.needs.pair, slope].filter((v): v is number => typeof v === 'number');
  return { level, marks, needs: l.needs };
}

/** Сообщение вместо вердикта; offline — добавить кнопку «Скачать район». */
function stripMessage(text: string, offline = false) {
  $('lsStatus').innerHTML = `<div class="ls-msg">${escapeHtml(text)}</div>`
    + (offline ? '<button class="ghost ls-dl" data-act="offline">Скачать район</button>' : '');
}

/** Пустое состояние (пульта нет) или строка с вердиктом. */
function syncMode() {
  const has = !!S.station;
  $('lsEmpty').hidden = has;
  $('lsMain').hidden = !has;
}

/**
 * Мгновенная реакция на движение карты (без расчёта): линия пульт → прицел следует за крестом
 * приглушённым цветом, в строке — дальность и азимут, вердикт «…» до прихода расчёта для этой точки.
 */
export function liveFollow() {
  const st = S.station;
  if (!st || stationGround === null) { hideGhost(); return; }
  const a = { lat: st.lat, lon: st.lon }, c = center();
  const dist = distance(a, c);
  // Прицел ушёл от посчитанной точки: полосы высотомера и предпросмотр — от старой цели, до нового расчёта шкала серая.
  if (last && distance(last.r.target, c) > 2) { last = null; setAltData(null); }
  if (dist < 5) { setLink(null); return; }
  if (moving) linkGhost(a);
  else linkLine(a, c, { color: PENDING_COL, dash: 0, op: 0.55 });
  const az = Math.round(bearing(a, c)) % 360;
  // Строки «нужная высота» и запасы не трогаем: высота строки не прыгает, а значения обновит расчёт.
  const v = $('lsStatus').querySelector('.ls-verdict');
  if (v) { v.className = 'ls-verdict muted'; v.innerHTML = `Считаю… · <span class="num">${km(dist)}</span> · аз. <span class="num">${az}°</span>`; }
  else $('lsStatus').innerHTML = `<div class="ls-verdict muted">Считаю… · <span class="num">${km(dist)}</span></div>`;
}

export async function updateLive() {
  syncMode();
  if (!S.station) { setLink(null); return; }
  // Очередь не копим: пока идёт расчёт, помним только факт «нужен ещё один» — он возьмёт текущий прицел.
  if (liveBusy) { livePending = true; return; }
  liveBusy = true;
  try {
    const c = center();
    let r: LinkCalc | null;
    try { r = await calcLink(c, LIVE_N); } catch (e) {
      if (!(e instanceof DemMissingError)) throw e;
      if (distance(center(), c) > 2) return; // прицел уже ушёл — устаревший ответ
      stripMessage('Нет данных рельефа здесь', true); setLink(null);
      last = null; setAltData(null);
      return;
    }
    if (!S.station) { syncMode(); setLink(null); last = null; setAltData(null); return; }
    // Ревизия цели: пока считали, прицел мог уйти — расчёт для прежней точки не применяем
    // (новый запрос уже запланирован движением карты).
    if (distance(center(), c) > 2) return;
    if (!r) {
      if (stationGroundFailed) stripMessage('Нет данных рельефа под пультом', true);
      else stripMessage(stationGround === null ? 'Загружаю высоту пульта…' : 'Прицел на пульте — сдвиньте карту');
      setLink(null);
      last = null; setAltData(null);
    } else {
      const radio = r.rp, video = r.vp; // с антенной в направлении на прицел
      const m = minHeightsForPair(r.elev, r.dist, r.hA, heightFnFor(r), radio, video);
      last = { r, radio, video, needs: video ? m : { rc: m.rc, pair: m.pair } };
      renderStrip(last, r.pair, S.droneH);
      setAltData(altData(last));
    }
  } finally {
    liveBusy = false;
    if (livePending) { livePending = false; updateLive(); }
  }
}

// ---------- Планировщик пересчёта при движении карты ----------

/**
 * Планировщик: fn вызывается через debounceMs после последнего poke() и, пока движение не прекращается,
 * не реже чем раз в maxWaitMs; now() — немедленно (на moveend). Очереди нет: один отложенный вызов.
 */
export function scheduler(fn: () => void, debounceMs: number, maxWaitMs: number) {
  let tDeb = 0, tMax = 0, last = 0;
  const run = () => {
    clearTimeout(tDeb); clearTimeout(tMax); tDeb = tMax = 0;
    last = performance.now();
    fn();
  };
  return {
    poke() {
      clearTimeout(tDeb);
      tDeb = window.setTimeout(run, debounceMs);
      if (!tMax) tMax = window.setTimeout(run, Math.max(0, maxWaitMs - (performance.now() - last)));
    },
    now: run,
  };
}

// Расчёт связи: после паузы 130 мс и при долгом перетаскивании не чаще 4 раз/с.
const liveCalc = scheduler(() => { if (S.station) updateLive(); }, 130, 250);
let followRaf = 0;

/** На каждый кадр движения карты: линия и азимут/дальность следуют за крестом без расчёта, расчёт — по планировщику. */
export function liveMove() {
  moving = true;
  if (!followRaf) followRaf = requestAnimationFrame(() => { followRaf = 0; liveFollow(); });
  if (S.station) liveCalc.poke();
}
/** Конец движения: дорисовать линию за крестом сразу. */
export function liveSettle() {
  cancelAnimationFrame(followRaf); followRaf = 0;
  moving = false;
  liveFollow();
}
/** Перерисовать строку посчитанного прицела без пересчёта трассы; false — прицел не посчитан. */
const redrawStrip = (): boolean => {
  if (!last || !S.station || distance(center(), last.r.target) > 2) return false;
  renderStrip(last, last.r.pair, S.droneH);
  return true;
};
// Кнопка линии у карты (linkLayer.ts): у посчитанного прицела — линия цветом статуса и метки, иначе — приглушённая.
onLinkToggle(() => { if (!redrawStrip()) liveSettle(); });
// Район скачан или удалён — «офлайн ✓» / «вне скачанных районов» в строке связи сразу, без пересчёта трассы.
on('offline', () => { redrawStrip(); });

/** Конец движения: посчитать связь немедленно. */
export function liveRecalc() {
  if (S.station) liveCalc.now();
}

// ---------- Строка связи ----------

let offerAt: LatLon | null = null;
const closeOffer = () => { $('lsOffer').hidden = true; $('linkStrip').classList.remove('offering'); offerAt = null; };

/** Предложение после «Где я»: поставить пульт в найденную точку. */
export function offerGpsStation(p: LatLon, accuracy: number) {
  const box = $('lsOffer');
  box.innerHTML = `<span>📍 Вы здесь <span class="muted num">±${Math.round(accuracy)} м</span></span>`
    + '<button class="primary" data-act="gps-set">Поставить пульт сюда</button><button class="mini ls-x" data-act="gps-close" title="Скрыть">✕</button>';
  box.hidden = false;
  $('linkStrip').classList.add('offering');
  offerAt = p;
}

/** Геолокация (общая для «По GPS» в строке и кнопки «Где я»): точка и точность в метрах. */
export function locate(): Promise<{ p: LatLon; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { toast('Геолокация не поддерживается'); resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ p: { lat: pos.coords.latitude, lon: pos.coords.longitude }, accuracy: pos.coords.accuracy }),
      (err) => {
        toast(err.code === 1 ? 'Доступ к геолокации запрещён' : err.code === 3 ? 'Геолокация: время ожидания вышло' : 'Не удалось определить местоположение');
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

export function initLinkStrip() {

  $('btnStHere').addEventListener('click', () => {
    closeOffer();
    setStation(center());
    toast('Пульт поставлен. Двигайте карту — прицел покажет связь. Антенны и их направление — нажмите на 📡', 5000);
  });
  $('btnStGps').addEventListener('click', async () => {
    const g = await locate();
    if (!g) return;
    closeOffer();
    map.flyTo({ center: [g.p.lon, g.p.lat], zoom: Math.max(map.getZoom(), 14) });
    setStation(g.p);
    toast(`Пульт поставлен по GPS (±${Math.round(g.accuracy)} м)`);
  });
  $('linkStrip').addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'offline') openOfflineSheet();
    else if (act === 'gps-set' && offerAt) { setStation(offerAt); closeOffer(); toast('Пульт поставлен в вашу точку'); }
    else if (act === 'gps-close') closeOffer();
    else if (act === 'aim' && last) {
      const az = Math.round(last.r.az) % 360;
      // Поворачиваем только антенны, у которых прицел вне луча (вторая могла быть направлена в другое место нарочно).
      for (const x of activeAntennaLines()) if (!inBeam(S.antenna[x], az, S.antenna[x].heading)) S.antenna[x].heading = az;
      emit('antenna'); toast(`Антенна направлена на прицел (${az}°)`);
    }
  });

  // Высотомер: пока тянут метку дрона — строка показывает связь на этой высоте (без нового профиля).
  // Предпросмотр — только для той точки, что сейчас под прицелом (иначе показали бы связь чужой цели).
  const fresh = () => !!last && !!S.station && distance(center(), last.r.target) <= 2;
  setAltPreview((hh) => { if (fresh()) renderStrip(last!, pairAt(last!, hh), hh); }, () => { if (fresh()) renderStrip(last!, last!.r.pair, S.droneH); });
  on('station', syncMode);
  syncMode();

  // Вся строка связи — вход в профиль трассы (кнопок «Профиль» нет — ширина строки целиком под текст).
  // Кнопки в строке («Антенну на прицел», «Скачать район») и сообщения без расчёта профиль не открывают.
  const openProf = (e: Event) => {
    if ((e.target as HTMLElement).closest('button') || !$('lsStatus').querySelector('.ls-verdict')) return;
    showProfile();
  };
  $('lsStatus').addEventListener('click', openProf);
  $('lsStatus').addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || (e.target as HTMLElement).closest('button')) return; // кнопки в строке — сами
    e.preventDefault();
    openProf(e);
  });

  // Высота строки (по содержимому) — в CSS-переменную: под строкой стоит плашка зоны, на узком экране высотомер
  // не заходит на строку. Скрытая строка (шторка, линейка) высоту не обнуляет: при её возврате плашка не наедет.
  const strip = $('linkStrip');
  const setH = () => { if (strip.offsetHeight) document.documentElement.style.setProperty('--strip-h', `${strip.offsetHeight}px`); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(strip);
  setH();
  updateLive();
}

// Пересчёт строки при смене пульта, радио, высоты дрона или антенн (маркер пульта перерисовывает station.ts —
// он подписан раньше). Пульт сдвинули — прежняя трасса не годится и для предпросмотра высоты.
on('station', () => { last = null; updateLive(); });
for (const ev of ['radio', 'height', 'antenna'] as const) on(ev, () => updateLive());
