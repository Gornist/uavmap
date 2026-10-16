// Точка входа: собирает модули; здесь же прицел с чипом высоты под ним, GPS и общие кнопки карты.
import './polyfills'; // первым: старые Chrome/WebView на пультах
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './styles/main.css';
import './styles/live.css';
import maplibregl from 'maplibre-gl';
import { S, $, map, center, toast, closeSheet, sheetOpen, on, persist, applyMapStyle } from './app';
import { h } from './ui';
import { initStation, stationGround } from './station';
import { initAltimeter } from './altimeter';
import { hereText } from './verdict';
import { addLinkLayers, setLinkLine, initLinkStrip, liveMove, liveSettle, liveRecalc, scheduler, locate, offerGpsStation } from './live';
import { openPointSheet } from './point';
import { initMarks, addMarkAtCenter } from './marks';
import { initRuler } from './ruler';
import { initCoverage, openCoverageSheet } from './coverageSheet';
import { findBestSpot } from './bestSpot';
import { initMenu, preloadUi } from './menu/index';
import { initPrefetch } from './prefetch';
import { initContours } from './contours';
import { initPwa } from './pwa';
import { initMyMaps } from './mymaps';
import { initMobile } from './mobile';
import { elevationAt } from './elevation';
import { initTheme } from './theme';
import { initReadability, readOpt } from './readability';

initTheme(); // первым делом: тема до отрисовки панелей
initReadability();

// Для отладки в консоли браузера (только dev-сборка).
if (import.meta.env.DEV) (window as unknown as { __map: typeof map }).__map = map;

// ---------- Прицел и чип высоты ----------
let hereH: number | null = null;
let heightRev = 0;

function renderHere() {
  $('crossChipText').textContent = hereText(hereH, stationGround, !!S.station);
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
map.once('idle', preloadUi); // разделы меню и профиль — когда карта догрузилась

// Стиль задан объектом, поэтому не ждём 'load' (он ждёт и тайлы).
function start() {
  addLinkLayers();
  initMarks();
  initRuler();
  initCoverage();
  initStation();
  initPrefetch(); // рельеф района вокруг пульта — в кеш, пока сеть отвечает
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
on('station', renderHere);

initLinkStrip();

initAltimeter();
$('crossChip').addEventListener('click', () => openPointSheet());
initMobile({ onPointPress: openPointSheet });

// Атрибуция MapLibre (compact) разворачивается сама — при старте и при смене источников (например, переход
// на запасные подписи) — и занимала верх экрана. Держим её свёрнутой в значок ⓘ, пока пользователь сам её не открыл.
{
  const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
  if (attrib) {
    let touched = false;
    // pointerdown (с захватом) приходит раньше, чем MapLibre разворачивает атрибуцию по click.
    attrib.addEventListener('pointerdown', () => { touched = true; }, true);
    attrib.addEventListener('keydown', () => { touched = true; }, true);
    const fold = () => { if (!touched && attrib.classList.contains('maplibregl-compact-show')) attrib.classList.remove('maplibregl-compact-show'); };
    new MutationObserver(fold).observe(attrib, { attributes: true, attributeFilter: ['class'] });
    fold();
  }
}

// «Яркое солнце»: у подписей на самой карте (горизонтали, метки потери связи, названия) ореол толще.
// Исходная ширина ореола слоя запоминается при первой встрече — слои добавляют разные модули и в разное время.
{
  const haloBase = new Map<string, unknown>();
  const applyHalo = () => {
    const sun = readOpt('sun');
    for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol') continue;
      if (!haloBase.has(l.id)) haloBase.set(l.id, map.getPaintProperty(l.id, 'text-halo-width') ?? 0);
      map.setPaintProperty(l.id, 'text-halo-width', sun ? 2.6 : haloBase.get(l.id)); // то же значение — MapLibre ничего не делает
    }
  };
  map.on('styledata', applyHalo);
  window.addEventListener('uavmap:readability', applyHalo);
}

$('zIn').addEventListener('click', () => map.zoomIn());
$('zOut').addEventListener('click', () => map.zoomOut());
$('btnGps').addEventListener('click', whereAmI);
$('btnLink').classList.toggle('on', S.map.link);
$('btnLink').setAttribute('aria-pressed', String(S.map.link));
$('btnLink').addEventListener('click', () => setLinkLine(!S.map.link));
$('btnHome').addEventListener('click', () => {
  if (!S.station) { toast('Пульт не поставлен'); return; }
  map.flyTo({ center: [S.station.lon, S.station.lat] });
});

$('btnMark').addEventListener('click', addMarkAtCenter);
$('btnZone').addEventListener('click', () => openCoverageSheet());
$('btnBest').addEventListener('click', () => findBestSpot(1000));
$('shClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

