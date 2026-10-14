// Горизонтали из DEM-тайлов (maplibre-contour): векторный источник + линии и подписи высот.
import maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { map, S } from './app';
import { DEM_URL } from './demTiles';

const LAYERS = ['contours-line', 'contours-line-major', 'contours-label'];

/**
 * Шаг горизонталей по зуму: [тонкие, утолщённые] в метрах. Форму рельефа даёт отмывка, поэтому линии редкие:
 * на обычном масштабе — через 100 м, частые (20 м) — только при сильном приближении.
 */
const THRESHOLDS: Record<number, [number, number]> = {
  0: [500, 1000], 9: [200, 1000], 11: [100, 500], 14: [20, 100],
};

/** Первый слой накладок (покрытие, связь, маршруты) — горизонтали вставляем под ним. */
function beforeOverlay(): string | undefined {
  const l = map.getStyle().layers.find((x) => x.id.startsWith('cov-') || x.id.startsWith('ov-'));
  return l ? l.id : map.getLayer('roads') ? 'roads' : undefined;
}

export function initContours() {
  if (map.getSource('contours')) return;
  const dem = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 13, worker: true });
  dem.setupMaplibre(maplibregl);
  map.addSource('contours', {
    type: 'vector',
    tiles: [dem.contourProtocolUrl({ thresholds: THRESHOLDS, contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level', extent: 4096, buffer: 1 })],
    maxzoom: 15,
  });
  const vis = S.map.contours ? 'visible' : 'none';
  const before = beforeOverlay();
  const src = { source: 'contours', 'source-layer': 'contours' };
  map.addLayer({ id: 'contours-line', type: 'line', ...src, filter: ['!=', ['get', 'level'], 1], layout: { visibility: vis }, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 15, 0.9] } }, before);
  map.addLayer({ id: 'contours-line-major', type: 'line', ...src, filter: ['==', ['get', 'level'], 1], layout: { visibility: vis }, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 15, 1.4] } }, before);
  map.addLayer({
    id: 'contours-label', type: 'symbol', ...src, filter: ['==', ['get', 'level'], 1],
    layout: { visibility: vis, 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' м'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 420 },
    paint: { 'text-halo-width': 1.2 }, // цвета — по подложке, в app.ts (overlayPaint)
  }, before);
}

export function applyContours() {
  for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', S.map.contours ? 'visible' : 'none');
}
