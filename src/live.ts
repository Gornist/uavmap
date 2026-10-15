// Строка связи над нижней панелью: пока пульта нет — «Пульт здесь / По GPS»; с пультом — вердикт до прицела,
// одна подсказка по высоте («Поднимите до 480 м — будет и видео»), мелко запасы и азимут, «Профиль».
// Данные для высотомера (связь на каждой высоте), линия пульт → прицел и планировщик пересчёта при движении карты.
import { S, $, map, center, setGeo, fc, line, toast, on } from './app';
import { km, dB, escapeHtml } from './format';
import { LatLon, distance, bearing } from './geo';
import { DemMissingError } from './elevation';
import { LinkResult, PairResult, RadioParams, analyzePair, minHeightsForPair } from './radio';
import { ICON, stCls, pairVerdict, statusCss, heightHint, HeightNeeds, freqName } from './verdict';
import { setStation, stationGround, stationGroundFailed, effRadio, effVideoOrNull, calcLink, heightFnFor, LinkCalc } from './station';
import { setAltData, setAltPreview } from './altimeter';
import { AltLevel } from './altScale';
import { showProfile } from './lazy';
import { openOfflineSheet } from './offline';

let liveBusy = false, livePending = false;
/** Для живой строки хватает 200 отсчётов: запас расходится с полным профилем (до 600) не более чем на 0,2 дБ. */
const LIVE_N = 200;
const PENDING_COL = '#8b949e';

let linkDrawn = false; // в источнике 'link' есть линия
/** Линия связи в слое карты (GeoJSON → воркер MapLibre); null — убрать. Призрак движения при этом прячется. */
function setLink(a: LatLon | null, c?: LatLon, props: Record<string, unknown> = {}) {
  ghost.hide();
  linkDrawn = !!(a && c);
  setGeo('link', a && c ? fc([line([[a.lon, a.lat], [c.lon, c.lat]], props)]) : fc());
}
const linkLine = (a: LatLon, c: LatLon, props: Record<string, unknown>) => setLink(a, c, props);

/**
 * «Призрак» линии на время движения карты: SVG в экранных координатах поверх карты. setData на каждый кадр
 * заставлял воркер MapLibre заново нарезать источник и перерисовывать слой; отрезок между двумя точками
 * в проекции карты прямой — SVG рисует ту же линию без воркера. По окончании движения линия снова в слое.
 */
const ghost = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg: SVGSVGElement | null = null, casing: SVGLineElement, ln: SVGLineElement;
  const mk = () => {
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'link-ghost');
    svg.setAttribute('aria-hidden', 'true');
    casing = document.createElementNS(NS, 'line');
    ln = document.createElementNS(NS, 'line');
    casing.setAttribute('stroke-width', '7');
    ln.setAttribute('stroke-width', '4');
    ln.setAttribute('stroke', PENDING_COL);
    ln.setAttribute('stroke-opacity', '0.55');
    for (const l of [casing, ln]) { l.setAttribute('stroke-linecap', 'round'); svg.appendChild(l); }
    // Сразу за canvas: маркеры (пульт, метки) MapLibre добавляет в тот же контейнер позже — они остаются сверху.
    const cv = map.getCanvas();
    cv.parentNode!.insertBefore(svg, cv.nextSibling);
  };
  return {
    show(a: LatLon) {
      if (!svg) mk();
      // Обводка — как у слоя (её цвет и прозрачность зависят от темы, см. overlayPaint в app.ts).
      const col = map.getLayer('ov-link-casing') ? map.getPaintProperty('ov-link-casing', 'line-color') : '#000';
      const op = map.getLayer('ov-link-casing') ? map.getPaintProperty('ov-link-casing', 'line-opacity') : 0.45;
      casing.setAttribute('stroke', typeof col === 'string' ? col : '#000');
      casing.setAttribute('stroke-opacity', String(typeof op === 'number' ? op : 0.45));
      const p = map.project([a.lon, a.lat]);
      const c = center(); // та же цель, что у расчёта (с padding карты она не в середине контейнера)
      const q = map.project([c.lon, c.lat]);
      for (const l of [casing, ln]) {
        l.setAttribute('x1', p.x.toFixed(1)); l.setAttribute('y1', p.y.toFixed(1));
        l.setAttribute('x2', q.x.toFixed(1)); l.setAttribute('y2', q.y.toFixed(1));
      }
      svg!.style.display = '';
    },
    hide() { if (svg) svg.style.display = 'none'; },
  };
})();
let moving = false; // карта движется (между первым move и moveend)

/** Третья строка (мелко): запасы линий и азимут. Прочерк вместо служебного запаса «дрон ниже склона». */
function subLine(pair: PairResult, az: number): string {
  const m = (x: LinkResult) => `<span class="${stCls(x.status)} num">${x.belowGround ? '—' : dB(x.margin)}</span>`;
  const lines = pair.video ? `Упр. ${m(pair.rc)} · Видео ${m(pair.video)}` : `Запас ${m(pair.rc)}`;
  return `${lines} · аз. <span class="num">${Math.round(az) % 360}°</span>`;
}

/** Последний расчёт трассы — для предпросмотра высоты на высотомере без нового профиля. */
let last: { r: LinkCalc; radio: RadioParams; video: RadioParams | null; needs: HeightNeeds } | null = null;

/** Связь на высоте hh для расчёта l (рельеф трассы тот же, меняется только высота дрона). */
const pairAt = (l: NonNullable<typeof last>, hh: number) => analyzePair(l.r.elev, l.r.dist, l.r.hA, heightFnFor(l.r)(hh), l.radio, l.video);

/** Вердикт, подсказка по высоте, запасы; линия на карте — цветом статуса. */
function renderStrip(l: NonNullable<typeof last>, pair: PairResult, hh: number) {
  const vName = l.video ? `Видео ${freqName(l.video.freqMHz)}` : undefined;
  $('lsStatus').innerHTML = `<div class="ls-verdict ${stCls(pair.status)}">${ICON[pair.status]} ${pairVerdict(pair)} · <span class="num">${km(l.r.dist)}</span></div>`
    + `<div class="ls-need">${escapeHtml(heightHint(hh, l.needs, vName, { rc: pair.rc.status, video: pair.video?.status }))}</div><div class="ls-sub muted">${subLine(pair, l.r.az)}</div>`;
  if (S.station) linkLine(S.station, l.r.target, { color: statusCss(pair.status), dash: pair.rc.los ? 0 : 1, op: 1 });
}

/** Данные высотомера: какая связь на каждой высоте; склон — если дрон оказался бы ниже рельефа у прицела. */
function altData(l: NonNullable<typeof last>) {
  const fn = heightFnFor(l.r);
  const level = (hh: number): AltLevel => (fn(hh) < l.r.groundB - 0.05 ? 'ground' : pairAt(l, hh).status);
  const slope = Math.max(0, l.r.groundB - fn(0)); // высота склона над точкой отсчёта
  const marks = [l.needs.rc, l.needs.video, l.needs.pair, slope].filter((v): v is number => typeof v === 'number');
  return { level, marks };
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
  if (!st || stationGround === null) { ghost.hide(); return; }
  const a = { lat: st.lat, lon: st.lon }, c = center();
  const dist = distance(a, c);
  // Прицел ушёл от посчитанной точки: полосы высотомера и предпросмотр — от старой цели, до нового расчёта шкала серая.
  if (last && distance(last.r.target, c) > 2) { last = null; setAltData(null); }
  if (dist < 5) { setLink(null); return; }
  if (moving) {
    if (linkDrawn) { linkDrawn = false; setGeo('link', fc()); }
    ghost.show(a);
  } else linkLine(a, c, { color: PENDING_COL, dash: 0, op: 0.55 });
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
    const radio = effRadio(), video = effVideoOrNull();
    try { r = await calcLink(c, radio, video, LIVE_N); } catch (e) {
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
/** Конец движения: посчитать связь немедленно. */
export function liveRecalc() {
  if (S.station) liveCalc.now();
}

// ---------- Слой линии связи и строка связи ----------

export function addLinkLayers() {
  map.addSource('link', { type: 'geojson', data: fc() });
  map.addLayer({ id: 'ov-link-casing', type: 'line', source: 'link', paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'ov-link', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 0], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['coalesce', ['get', 'op'], 1] } });
  map.addLayer({ id: 'ov-link-dash', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 1], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['coalesce', ['get', 'op'], 1], 'line-dasharray': [2, 2] } });
}

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
    toast('Пульт поставлен. Двигайте карту — прицел покажет связь');
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
  });

  // Высотомер: пока тянут метку дрона — строка показывает связь на этой высоте (без нового профиля).
  // Предпросмотр — только для той точки, что сейчас под прицелом (иначе показали бы связь чужой цели).
  const fresh = () => !!last && !!S.station && distance(center(), last.r.target) <= 2;
  setAltPreview((hh) => { if (fresh()) renderStrip(last!, pairAt(last!, hh), hh); }, () => { if (fresh()) renderStrip(last!, last!.r.pair, S.droneH); });
  on('station', syncMode);
  syncMode();

  $('btnProfile').addEventListener('click', () => showProfile());

  // Высота строки (по содержимому) — в CSS-переменную: на узком экране высотомер не заходит на строку.
  const strip = $('linkStrip');
  const setH = () => document.documentElement.style.setProperty('--strip-h', `${strip.offsetHeight}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(strip);
  setH();
  updateLive();
}

// Пересчёт строки при смене пульта или радио (маркер пульта перерисовывает station.ts — он подписан раньше).
// Пульт сдвинули — прежняя трасса не годится и для предпросмотра высоты.
on('station', () => { last = null; updateLive(); });
on('radio', () => updateLive());
