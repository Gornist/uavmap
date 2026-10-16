// Линейка и маршруты.
// Данные маршрутов — S.routes; после изменений emit('routes').
import maplibregl from 'maplibre-gl';
import { S, $, map, center, setGeo, fc, line, toast, emit, on, accentColor } from './app';
import { distance, bearing } from './geo';
import { km } from './format';
import { uid } from './store';

let rulerObserved = false; // за высотой панели линейки следим с первого включения

let active = false;
let pts: [number, number][] = []; // [lon, lat]
let labels: maplibregl.Marker[] = [];

const total = () => pts.reduce((s, p, i) => (i ? s + distance({ lat: pts[i - 1][1], lon: pts[i - 1][0] }, { lat: p[1], lon: p[0] }) : 0), 0);

function drawRoutes() {
  setGeo('routes', fc(S.routes.filter((r) => r.pts.length > 1).map((r) => line(r.pts, { name: r.name }))));
  labels.forEach((m) => m.remove());
  labels = S.routes.filter((r) => r.pts.length > 1).map((r) => {
    const el = document.createElement('div');
    el.className = 'route-label';
    el.textContent = r.name;
    const mid = r.pts[Math.floor(r.pts.length / 2)];
    return new maplibregl.Marker({ element: el }).setLngLat(mid).addTo(map);
  });
}

function drawRuler() {
  const c = center();
  const cur: [number, number] = [c.lon, c.lat];
  setGeo('ruler', fc([
    ...(pts.length > 1 ? [line(pts, { live: 0 })] : []),
    ...(active && pts.length ? [line([pts[pts.length - 1], cur], { live: 1 })] : []),
    ...pts.map((p): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} })),
  ]));
  if (!active) return;
  let txt = 'Наведите прицел и нажмите «+ Точка» (или коснитесь карты)';
  if (pts.length) {
    const last = { lat: pts[pts.length - 1][1], lon: pts[pts.length - 1][0] };
    const d = distance(last, c);
    txt = `Точек: ${pts.length} · всего ${km(total())}`;
    if (d >= 1) txt += ` · до прицела ${km(d)}, азимут ${Math.round(bearing(last, c)) % 360}°`;
  }
  $('rulerText').textContent = txt;
}

function addPoint(lon: number, lat: number) { pts.push([lon, lat]); drawRuler(); }

/** Слои линейки/маршрутов и обработчики #rulerBar. */
export function initRuler(): void {
  map.addSource('routes', { type: 'geojson', data: fc() });
  map.addSource('ruler', { type: 'geojson', data: fc() });
  map.addLayer({ id: 'ov-routes-casing', type: 'line', source: 'routes', paint: { 'line-color': '#000', 'line-width': 5, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'ov-routes', type: 'line', source: 'routes', paint: { 'line-color': '#4aa3ff', 'line-width': 3 } });
  const accent = accentColor(); // при смене темы цвет обновляет applyMapTheme (app.ts)
  map.addLayer({ id: 'ov-ruler', type: 'line', source: 'ruler', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'live'], 0]], paint: { 'line-color': accent, 'line-width': 3 } });
  map.addLayer({ id: 'ov-ruler-live', type: 'line', source: 'ruler', filter: ['==', ['get', 'live'], 1], paint: { 'line-color': accent, 'line-width': 2, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'ov-ruler-pts', type: 'circle', source: 'ruler', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': accent, 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });

  drawRoutes();
  on('routes', drawRoutes);
  map.on('move', () => { if (active) drawRuler(); });
  map.on('click', (e) => { if (active) addPoint(e.lngLat.lng, e.lngLat.lat); });

  // Подписи кнопок задаём здесь: разметка панели — в index.html, а слова — забота линейки.
  for (const [id, t] of [['rulerAdd', '+ Точка'], ['rulerUndo', 'Отменить'], ['rulerSave', 'Сохранить маршрут'], ['rulerDone', 'Готово']]) {
    const b = document.getElementById(id);
    if (b) { b.textContent = t; b.removeAttribute('title'); }
  }
  $('rulerAdd').addEventListener('click', () => { const c = center(); addPoint(c.lon, c.lat); });
  $('rulerUndo').addEventListener('click', () => { if (!pts.length) { toast('Точек нет'); return; } pts.pop(); drawRuler(); });
  $('rulerSave').addEventListener('click', () => {
    if (pts.length < 2) { toast('Нужно хотя бы две точки'); return; }
    S.routes.push({ id: uid(), name: `Маршрут ${S.routes.length + 1}`, pts: pts.slice() });
    pts = [];
    emit('routes');
    drawRuler();
    toast('Маршрут сохранён — он в Меню → Инструменты');
  });
  $('rulerDone').addEventListener('click', () => { if (active) toggleRuler(); });
}

/** Линейка включена (для меню «Инструменты»). */
export const rulerActive = () => active;

/** Включить/выключить режим линейки (меню → «Инструменты»). Пока линейка включена, строка связи скрыта. */
export function toggleRuler(): void {
  active = !active;
  $('rulerBar').hidden = !active;
  const strip = document.getElementById('linkStrip');
  if (strip) strip.hidden = active;
  document.body.classList.toggle('ruler-on', active);
  // Высота панели линейки — в CSS-переменную: кнопки карты в правом нижнем углу встают над ней.
  // Следим за размером (поворот экрана, перенос кнопок в два ряда); скрытая панель высоту не обнуляет.
  if (active && !rulerObserved) {
    rulerObserved = true;
    const bar = $('rulerBar');
    const setH = () => { if (bar.offsetHeight) document.documentElement.style.setProperty('--ruler-h', `${bar.offsetHeight}px`); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(bar);
    else window.addEventListener('resize', setH);
    requestAnimationFrame(setH);
  }
  map.getCanvas().style.cursor = active ? 'crosshair' : '';
  if (!active) pts = [];
  drawRuler();
}
