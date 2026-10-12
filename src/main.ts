// Точка входа: собирает модули. Владелец: карточка 1A (docs/PLAN.md).
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './styles/main.css';
import maplibregl from 'maplibre-gl';
import { S, $, h, map, center, fc, toast, openSheet, closeSheet, sheetOpen, on, emit, persist, applyMapStyle } from './app';
import { setStation, initStation, updateLive, showProfile, findBestSpot, altModeText } from './link';
import { initMarks, addMarkAtCenter } from './marks';
import { initRuler, toggleRuler } from './ruler';
import { initCoverage, openCoverageSheet } from './coverage';
import { initMenu } from './menu';
import { initContours } from './contours';
import { initPwa } from './pwa';
import { initMyMaps } from './mymaps';
import { initMobile } from './mobile';
import { formatCoords } from './coords';
import { elevationAt } from './elevation';
import { distance, bearing, fmtDist, type LatLon } from './geo';
import { uid } from './store';

// Для отладки в консоли браузера (только dev-сборка).
if (import.meta.env.DEV) (window as unknown as { __map: typeof map }).__map = map;

// ---------- Прицел и плашка ----------
let hereH: number | null = null;
let heightRev = 0;

function renderHere() {
  const c = center();
  const f = formatCoords(c.lat, c.lon, S.coordFormat);
  $('hereCoords').innerHTML = f.rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('');
  const t = hereH === null ? '—' : String(Math.round(hereH));
  $('hereH').textContent = t;
  $('crossLabel').innerHTML = `${t} м ${f.short}`;
}

async function refreshHeight() {
  const rev = ++heightRev;
  const e = await elevationAt(center()).catch(() => null);
  if (rev !== heightRev) return; // пришёл устаревший ответ
  hereH = e;
  renderHere();
}

function throttle(fn: () => void, ms: number) {
  let t = 0, pending = false;
  return () => {
    if (t) { pending = true; return; }
    fn();
    t = window.setTimeout(() => { t = 0; if (pending) { pending = false; fn(); } }, ms);
  };
}

// ---------- Строка связи ----------
function initLinkStrip() {
  const strip = $('linkStrip'), btn = $('btnLink');
  const inAnt = $<HTMLInputElement>('inAnt'), inDrone = $<HTMLInputElement>('inDrone');
  const showStrip = (v: boolean) => { strip.hidden = !v; btn.classList.toggle('on', v); };

  btn.addEventListener('click', () => {
    if (!$('rulerBar').hidden) toggleRuler();
    if (btn.classList.contains('on') && S.station) { showStrip(false); return; }
    if (!S.station) {
      setStation(center());
      toast('Пульт поставлен в прицел. Двигайте карту — прицел покажет связь');
    }
    showStrip(true);
    updateLive();
  });
  $('lsClose').addEventListener('click', () => showStrip(false));

  strip.querySelectorAll<HTMLElement>('[data-ls]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.ls === 'zone') openCoverageSheet();
    else if (b.dataset.ls === 'best') openBestSheet();
  }));

  const syncInputs = () => {
    inAnt.disabled = !S.station;
    if (document.activeElement !== inAnt) inAnt.value = S.station ? String(S.station.antH) : '';
    if (document.activeElement !== inDrone) inDrone.value = String(S.droneH);
    $('altModeLbl').textContent = `(${altModeText()})`;
  };
  inAnt.addEventListener('input', () => {
    const v = parseFloat(inAnt.value);
    if (S.station && Number.isFinite(v) && v >= 0) { S.station.antH = v; emit('station'); }
  });
  inDrone.addEventListener('input', () => {
    const v = parseFloat(inDrone.value);
    if (Number.isFinite(v) && v >= 0) { S.droneH = v; emit('radio'); }
  });
  on('station', syncInputs);
  on('radio', syncInputs);
  syncInputs();

  $('btnProfile').addEventListener('click', () => showProfile());
}

function openBestSheet() {
  const b = openSheet('Где встать', `
    <p class="hint">Подбор места для пульта, откуда лучше всего видно точку в прицеле. Выберите радиус поиска.</p>
    <div class="chips" id="bestR"></div>`);
  for (const r of [500, 1000, 2000, 3000]) {
    const c = document.createElement('button');
    c.textContent = r < 1000 ? `${r} м` : `${r / 1000} км`;
    c.addEventListener('click', () => { closeSheet(); findBestSpot(r); });
    b.querySelector('#bestR')!.appendChild(c);
  }
}

// ---------- Карточка «Точка» ----------
let pointPin: maplibregl.Marker | null = null;
const clearPin = () => { pointPin?.remove(); pointPin = null; };

/** Шторка «Точка»: для прицела или (долгое нажатие / правый клик) для места нажатия. */
function openPointSheet(at?: LatLon) {
  const p = at ?? center();
  const body = h('<div></div>');
  let html = `<div class="kv"><div><small>Рельеф</small><b id="ptH">…</b></div>`;
  for (const f of ['sk42', 'dd', 'dms'] as const) {
    const c = formatCoords(p.lat, p.lon, f);
    html += `<div><small>${c.label}</small><b>${c.short}</b></div>`;
  }
  if (S.station) {
    const a = { lat: S.station.lat, lon: S.station.lon };
    html += `<div><small>От пульта</small><b>${fmtDist(distance(a, p))}, аз. ${bearing(a, p).toFixed(0)}°</b></div>`;
  }
  html += `</div>
    <div class="row"><button class="ghost" id="ptSt">Пульт сюда</button><button class="ghost" id="ptMk">Метка здесь</button><button class="ghost" id="ptPr">Профиль сюда</button><button class="ghost" id="ptCp">Копировать координаты</button></div>`;
  body.innerHTML = html;
  const q = (s: string) => body.querySelector(s) as HTMLElement;
  elevationAt(p).then((e) => { if (body.isConnected) q('#ptH').textContent = e === null ? '—' : `${Math.round(e)} м`; });
  q('#ptSt').addEventListener('click', () => { setStation(p); closeSheet(); toast('Пульт поставлен'); });
  q('#ptMk').addEventListener('click', () => {
    S.marks.push({ id: uid(), name: `Метка ${S.marks.length + 1}`, note: '', lat: p.lat, lon: p.lon, color: '#e3a948', folder: '', created: Date.now() });
    emit('marks'); toast('Метка добавлена');
  });
  q('#ptPr').addEventListener('click', () => showProfile(p));
  q('#ptCp').addEventListener('click', () => {
    const text = formatCoords(p.lat, p.lon, S.coordFormat).short.replace(/<\/?em>/g, '');
    navigator.clipboard.writeText(text).then(() => toast('Координаты скопированы'), () => toast('Не удалось скопировать'));
  });
  openSheet('Точка', body, clearPin);
  clearPin();
  if (at) pointPin = new maplibregl.Marker({ element: h('<div class="pt-pin"></div>') }).setLngLat([p.lon, p.lat]).addTo(map);
}

// ---------- GPS ----------
let gpsMarker: maplibregl.Marker | null = null;
function locate() {
  if (!navigator.geolocation) { toast('Геолокация не поддерживается'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    const ll: [number, number] = [pos.coords.longitude, pos.coords.latitude];
    if (!gpsMarker) gpsMarker = new maplibregl.Marker({ element: h('<div class="gps-dot"></div>') }).setLngLat(ll).addTo(map);
    else gpsMarker.setLngLat(ll);
    map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15) });
  }, (err) => {
    toast(err.code === 1 ? 'Доступ к геолокации запрещён' : err.code === 3 ? 'Геолокация: время ожидания вышло' : 'Не удалось определить местоположение');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

// ---------- Слои ----------
function addLinkLayers() {
  map.addSource('link', { type: 'geojson', data: fc() });
  map.addLayer({ id: 'ov-link-casing', type: 'line', source: 'link', paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'ov-link', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 0], paint: { 'line-color': ['get', 'color'], 'line-width': 3 } });
  map.addLayer({ id: 'ov-link-dash', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 1], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [2, 2] } });
}

initMenu();
initPwa();

// Стиль задан объектом, поэтому не ждём 'load' (он ждёт и тайлы).
function start() {
  addLinkLayers();
  initMarks();
  initRuler();
  initCoverage();
  initStation();
  initContours();
  initMyMaps();
  applyMapStyle();
  refreshHeight();
}
if (map.isStyleLoaded()) start(); else map.once('style.load', start);

renderHere();
const liveThrottled = throttle(() => { if (S.station) updateLive(); }, 200);
const heightThrottled = throttle(refreshHeight, 250);
map.on('move', () => { renderHere(); liveThrottled(); heightThrottled(); });
map.on('moveend', () => {
  const c = map.getCenter();
  S.map.center = [c.lng, c.lat];
  S.map.zoom = map.getZoom();
  persist();
  refreshHeight();
  if (S.station) updateLive();
});
on('coords', renderHere);

initLinkStrip();

$('infoToggle').addEventListener('click', () => {
  const c = $('infoCard').classList.toggle('collapsed');
  $('infoToggle').textContent = c ? '+' : '−';
});
$('btnPoint').addEventListener('click', () => openPointSheet());
initMobile({ onPointPress: openPointSheet });

$('zIn').addEventListener('click', () => map.zoomIn());
$('zOut').addEventListener('click', () => map.zoomOut());
$('btnGps').addEventListener('click', locate);
$('btnHome').addEventListener('click', () => {
  if (!S.station) { toast('Пульт не поставлен'); return; }
  map.flyTo({ center: [S.station.lon, S.station.lat] });
});

$('btnMark').addEventListener('click', addMarkAtCenter);
$('btnRuler').addEventListener('click', toggleRuler);
$('btnLabels').addEventListener('click', () => { S.map.labels = !S.map.labels; applyMapStyle(); });
$('btnFull').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (!el.requestFullscreen) { toast('Полноэкранный режим не поддерживается на этом устройстве'); return; }
  el.requestFullscreen().catch(() => toast('Не удалось включить полный экран'));
});
$('shClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

