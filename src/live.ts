// Строка связи над нижней панелью: пока пульта нет — «Пульт здесь / По GPS»; с пультом — вердикт до прицела,
// нужная высота по каждой линии, запасы и азимут, поля «Дрон» и «Антенна», «Профиль». Линия пульт → прицел
// на карте и планировщик пересчёта при движении карты.
import { S, $, map, center, setGeo, fc, line, toast, emit, on } from './app';
import { km, dB, escapeHtml } from './format';
import { LatLon, distance, bearing } from './geo';
import { DemMissingError } from './elevation';
import { LinkResult } from './radio';
import { ICON, stCls, pairVerdict, statusCss, needLinesHtml } from './verdict';
import { setStation, stationGround, stationGroundFailed, effRadio, effVideoOrNull, calcLink, lineNeeds, LinkCalc } from './station';
import { showProfile } from './profileSheet';
import { openOfflineSheet } from './offline';

let liveBusy = false, livePending = false;
/** Для живой строки хватает 200 отсчётов: запас расходится с полным профилем (до 600) не более чем на 0,2 дБ. */
const LIVE_N = 200;
const PENDING_COL = '#8b949e';

const linkLine = (a: LatLon, c: LatLon, props: Record<string, unknown>) =>
  setGeo('link', fc([line([[a.lon, a.lat], [c.lon, c.lat]], props)]));

/** Третья строка (мелко): запасы линий и азимут. Прочерк вместо служебного запаса «дрон ниже склона». */
function subLine(r: LinkCalc): string {
  const m = (x: LinkResult) => `<span class="${stCls(x.status)} num">${x.belowGround ? '—' : dB(x.margin)}</span>`;
  const lines = r.vres ? `Упр. ${m(r.res)} · Видео ${m(r.vres)}` : `Запас ${m(r.res)}`;
  return `${lines} · аз. <span class="num">${Math.round(r.az) % 360}°</span>`;
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
  if (!st || stationGround === null) return;
  const a = { lat: st.lat, lon: st.lon }, c = center();
  const dist = distance(a, c);
  if (dist < 5) { setGeo('link', fc()); return; }
  linkLine(a, c, { color: PENDING_COL, dash: 0, op: 0.55 });
  const az = Math.round(bearing(a, c)) % 360;
  // Строки «нужная высота» и запасы не трогаем: высота строки не прыгает, а значения обновит расчёт.
  const v = $('lsStatus').querySelector('.ls-verdict');
  if (v) { v.className = 'ls-verdict muted'; v.innerHTML = `Считаю… · <span class="num">${km(dist)}</span> · аз. <span class="num">${az}°</span>`; }
  else $('lsStatus').innerHTML = `<div class="ls-verdict muted">Считаю… · <span class="num">${km(dist)}</span></div>`;
}

export async function updateLive() {
  syncMode();
  if (!S.station) { setGeo('link', fc()); return; }
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
      stripMessage('Нет данных рельефа здесь', true); setGeo('link', fc());
      return;
    }
    if (!S.station) { syncMode(); setGeo('link', fc()); return; }
    // Ревизия цели: пока считали, прицел мог уйти — расчёт для прежней точки не применяем
    // (новый запрос уже запланирован движением карты).
    if (distance(center(), c) > 2) return;
    if (!r) {
      if (stationGroundFailed) stripMessage('Нет данных рельефа под пультом', true);
      else stripMessage(stationGround === null ? 'Загружаю высоту пульта…' : 'Прицел на пульте — сдвиньте карту');
      setGeo('link', fc());
    } else {
      const { res, pair } = r;
      const needs = needLinesHtml(lineNeeds(r, radio, video));
      $('lsStatus').innerHTML = `<div class="ls-verdict ${stCls(pair.status)}">${ICON[pair.status]} ${pairVerdict(pair)} · <span class="num">${km(r.dist)}</span></div>`
        + `<div class="ls-need">${needs}</div><div class="ls-sub muted">${subLine(r)}</div>`;
      linkLine(S.station, c, { color: statusCss(pair.status), dash: res.los ? 0 : 1, op: 1 });
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
  if (!followRaf) followRaf = requestAnimationFrame(() => { followRaf = 0; liveFollow(); });
  if (S.station) liveCalc.poke();
}
/** Конец движения: дорисовать линию за крестом сразу. */
export function liveSettle() {
  cancelAnimationFrame(followRaf); followRaf = 0;
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

/** Число из поля в пределах [min, max]; иначе — вернуть прежнее значение и коротко подсказать. */
function bindNumber(inp: HTMLInputElement, min: number, max: number, hint: string, get: () => number | null, set: (v: number) => void) {
  const parse = () => { const v = parseFloat(inp.value.replace(',', '.')); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
  inp.addEventListener('input', () => { const v = parse(); if (v !== null && v !== get()) set(v); });
  inp.addEventListener('change', () => {
    if (parse() !== null) return;
    const old = get();
    inp.value = old === null ? '' : String(old);
    toast(hint);
  });
}

export function initLinkStrip() {
  const inAnt = $<HTMLInputElement>('inAnt'), inDrone = $<HTMLInputElement>('inDrone');

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

  const syncInputs = () => {
    syncMode();
    if (document.activeElement !== inAnt) inAnt.value = S.station ? String(S.station.antH) : '';
    if (document.activeElement !== inDrone) inDrone.value = String(S.droneH);
    const mode = S.altMode === 'takeoff' ? 'над взлётом' : 'над рельефом';
    $('altModeLbl').textContent = mode;
    $('lblDrone').title = `Высота дрона ${mode} (меню → Расчёт)`;
  };
  bindNumber(inAnt, 0, 100, 'Антенна: от 0 до 100 м', () => S.station?.antH ?? null, (v) => {
    if (S.station) { S.station.antH = v; emit('station'); }
  });
  bindNumber(inDrone, 0, 5000, 'Высота дрона: от 0 до 5000 м', () => S.droneH, (v) => { S.droneH = v; emit('radio'); });
  on('station', syncInputs);
  on('radio', syncInputs);
  syncInputs();

  $('btnProfile').addEventListener('click', () => showProfile());

  // Высота строки (по содержимому) — в CSS-переменную: над строкой стоит масштаб карты.
  const strip = $('linkStrip');
  const setH = () => document.documentElement.style.setProperty('--strip-h', `${strip.offsetHeight}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(strip);
  setH();
  updateLive();
}

// Пересчёт строки при смене пульта или радио (маркер пульта перерисовывает station.ts — он подписан раньше).
on('station', () => updateLive());
on('radio', () => updateLive());
