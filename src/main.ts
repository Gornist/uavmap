// Точка входа: собирает модули; здесь же прицел с плашкой (координаты, высота), GPS и общие кнопки карты.
import './polyfills'; // первым: старые Chrome/WebView на пультах
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './styles/main.css';
import './styles/live.css';
import maplibregl from 'maplibre-gl';
import { S, $, map, center, toast, closeSheet, sheetOpen, on, persist, applyMapStyle } from './app';
import { h } from './ui';
import { initStation } from './station';
import { addLinkLayers, initLinkStrip, liveMove, liveSettle, liveRecalc, scheduler, locate, offerGpsStation } from './live';
import { openPointSheet } from './point';
import { initMarks, addMarkAtCenter } from './marks';
import { initRuler } from './ruler';
import { initCoverage, openCoverageSheet } from './coverageSheet';
import { findBestSpot } from './bestSpot';
import { initMenu } from './menu/index';
import { initContours } from './contours';
import { initPwa } from './pwa';
import { initMyMaps } from './mymaps';
import { initMobile } from './mobile';
import { formatCoords } from './coords';
import { elevationAt } from './elevation';
import { initTheme } from './theme';

initTheme(); // первым делом: тема до отрисовки панелей

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
  // Подпись у прицела дублирует плашку — показываем её, только когда плашка свёрнута (телефон).
  $('crossLabel').innerHTML = $('infoCard').classList.contains('collapsed') ? `${t} м ${f.short}` : '';
}

async function refreshHeight() {
  const rev = ++heightRev;
  const e = await elevationAt(center()).catch(() => null);
  if (rev !== heightRev) return; // пришёл устаревший ответ
  hereH = e;
  renderHere();
}

// ---------- GPS ----------
let gpsMarker: maplibregl.Marker | null = null;
async function whereAmI() {
  const g = await locate();
  if (!g) return;
  const ll: [number, number] = [g.p.lon, g.p.lat];
  if (!gpsMarker) gpsMarker = new maplibregl.Marker({ element: h('<div class="gps-dot"></div>') }).setLngLat(ll).addTo(map);
  else gpsMarker.setLngLat(ll);
  map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15) });
  offerGpsStation(g.p, g.accuracy);
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
// Высота под прицелом — каждые ≤150 мс; расчёт связи планирует live.ts.
const heightCalc = scheduler(refreshHeight, 60, 150);
map.on('move', () => {
  renderHere();
  liveMove();
  heightCalc.poke();
});
map.on('moveend', () => {
  const c = map.getCenter();
  S.map.center = [c.lng, c.lat];
  S.map.zoom = map.getZoom();
  persist();
  liveSettle();
  heightCalc.now();
  liveRecalc();
});
on('coords', renderHere);

initLinkStrip();

$('infoToggle').addEventListener('click', () => {
  const c = $('infoCard').classList.toggle('collapsed');
  $('infoToggle').textContent = c ? '+' : '−';
  renderHere();
});
$('btnPoint').addEventListener('click', () => openPointSheet());
initMobile({ onPointPress: openPointSheet });
renderHere(); // плашка могла свернуться на телефоне — обновить подпись у прицела

$('zIn').addEventListener('click', () => map.zoomIn());
$('zOut').addEventListener('click', () => map.zoomOut());
$('btnGps').addEventListener('click', whereAmI);
$('btnHome').addEventListener('click', () => {
  if (!S.station) { toast('Пульт не поставлен'); return; }
  map.flyTo({ center: [S.station.lon, S.station.lat] });
});

$('btnMark').addEventListener('click', addMarkAtCenter);
$('btnZone').addEventListener('click', () => openCoverageSheet());
$('btnBest').addEventListener('click', () => findBestSpot(1000));
$('shClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

