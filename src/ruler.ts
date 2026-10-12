// Линейка и маршруты. Владелец: карточка 1A (docs/PLAN.md).
// Данные маршрутов — S.routes; после изменений emit('routes').
import maplibregl from 'maplibre-gl';
import { S, $, map, center, setGeo, fc, line, toast, emit, on } from './app';
import { distance, bearing, fmtDist } from './geo';
import { uid } from './store';

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
  let txt = 'Линейка: ставьте точки прицелом';
  if (pts.length) {
    const last = { lat: pts[pts.length - 1][1], lon: pts[pts.length - 1][0] };
    const seg = distance(last, c);
    txt = `${pts.length} точ. · всего ${fmtDist(total())} · отрезок ${fmtDist(seg)}, аз. ${bearing(last, c).toFixed(0)}°`;
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
  map.addLayer({ id: 'ov-ruler', type: 'line', source: 'ruler', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'live'], 0]], paint: { 'line-color': '#e3a948', 'line-width': 3 } });
  map.addLayer({ id: 'ov-ruler-live', type: 'line', source: 'ruler', filter: ['==', ['get', 'live'], 1], paint: { 'line-color': '#e3a948', 'line-width': 2, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'ov-ruler-pts', type: 'circle', source: 'ruler', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#e3a948', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });

  drawRoutes();
  on('routes', drawRoutes);
  map.on('move', () => { if (active) drawRuler(); });
  map.on('click', (e) => { if (active) addPoint(e.lngLat.lng, e.lngLat.lat); });

  $('rulerAdd').addEventListener('click', () => { const c = center(); addPoint(c.lon, c.lat); });
  $('rulerUndo').addEventListener('click', () => { pts.pop(); drawRuler(); });
  $('rulerSave').addEventListener('click', () => {
    if (pts.length < 2) { toast('Нужно хотя бы две точки'); return; }
    S.routes.push({ id: uid(), name: `Маршрут ${S.routes.length + 1}`, pts: pts.slice() });
    pts = [];
    emit('routes');
    drawRuler();
    toast('Маршрут сохранён');
  });
  $('rulerDone').addEventListener('click', () => { if (active) toggleRuler(); });
}

/** Включить/выключить режим линейки (кнопка «📏 Линейка»). */
export function toggleRuler(): void {
  active = !active;
  $('rulerBar').hidden = !active;
  $('linkStrip').hidden = active || !$('btnLink').classList.contains('on');
  $('btnRuler').classList.toggle('on', active);
  map.getCanvas().style.cursor = active ? 'crosshair' : '';
  if (!active) pts = [];
  drawRuler();
}
