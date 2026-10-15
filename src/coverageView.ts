// Зона покрытия на карте: растровая накладка (уровень связи или нужная высота), граница связи
// и слои MapLibre (cov-raster, cov-edge). Хранит только то, что нарисовано сейчас.
import { S, map, setGeo, fc, line, accentColor } from './app';
import { destination, lonLatToPixel, pixelToLonLat } from './geo';
import { rasterIndex } from './coverageRaster';
import { STATUS_RGB } from './theme';
import { CoverageShown, firstLossAt, heightIndex, levelAt, lineOf, paletteIndex } from './coverageStats';

const CANVAS = 768;
const RZ = 20; // «виртуальный» зум для равномерных меркаторских пикселей растра
/** Палитра режима «Нужную высоту»: от низкой высоты к высокой. */
export const PALETTE = ['#b8e986', '#7ed957', '#2fbf8f', '#22a3b8', '#3b7fd6', '#5a5bd0', '#7b3fbf', '#9c27a0'];

type Quad = [[number, number], [number, number], [number, number], [number, number]];
let rasterBounds: { coords: Quad; x0: number; y0: number; wx: number; wy: number; w: number; hh: number } | null = null;
let current: CoverageShown | null = null; // результат на карте

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const PAL_RGB = PALETTE.map(rgb);

/** Первый слой других модулей (ov-*) — свои слои вставляем под ним. */
function beforeOv(): string | undefined {
  return map.getStyle().layers.find((l) => l.id.startsWith('ov-'))?.id;
}

/** Слой границы связи (пустой до первого расчёта). */
export function initCoverageView(): void {
  map.addSource('cov-edge', { type: 'geojson', data: fc() });
  map.addLayer({
    id: 'cov-edge', type: 'line', source: 'cov-edge',
    paint: { 'line-color': accentColor(), 'line-width': 2, 'line-dasharray': [3, 2] },
  }, beforeOv());
}

/** Убрать растр и границу с карты, освободить картинку. */
export function clearCoverageView(): void {
  current = null;
  rasterBounds = null;
  removeRaster();
  pixCache = null;
  setGeo('cov-edge', fc());
}

export function setCoverageOpacity(v: number): void {
  if (map.getLayer('cov-raster')) map.setPaintProperty('cov-raster', 'raster-opacity', v);
}

// ---------- растр ----------
function layoutRaster(c: CoverageShown) {
  const n = destination(c.center, 0, c.radius), s = destination(c.center, 180, c.radius);
  const e = destination(c.center, 90, c.radius), w = destination(c.center, 270, c.radius);
  const [x0, y0] = lonLatToPixel(w.lon, n.lat, RZ);
  const [x1, y1] = lonLatToPixel(e.lon, s.lat, RZ);
  const wx = x1 - x0, wy = y1 - y0;
  const N = c.prelim ? CANVAS / 2 : CANVAS; // предварительный проход грубый (лучей ×¼): растру хватает вчетверо меньше пикселей
  const wPx = wx >= wy ? N : Math.max(8, Math.round((N * wx) / wy));
  const hPx = wx >= wy ? Math.max(8, Math.round((N * wy) / wx)) : N;
  const nw = pixelToLonLat(x0, y0, RZ), ne = pixelToLonLat(x1, y0, RZ);
  const se = pixelToLonLat(x1, y1, RZ), sw = pixelToLonLat(x0, y1, RZ);
  return { coords: [nw, ne, se, sw] as Quad, x0, y0, wx, wy, w: wPx, hh: hPx };
}

// Геометрия пикселей растра кешируется: смена высоты/линии/режима её не пересчитывает.
let pixCache: { key: string; idx: Int32Array } | null = null;
function pixelIndex(c: CoverageShown, L: NonNullable<typeof rasterBounds>): Int32Array {
  const g = { lat: c.center.lat, lon: c.center.lon, radius: c.radius, rays: c.rays, step: c.step, samples: c.res.samples, x0: L.x0, y0: L.y0, wx: L.wx, wy: L.wy, w: L.w, h: L.hh, z: RZ };
  const key = Object.values(g).join();
  if (pixCache?.key !== key) pixCache = { key, idx: rasterIndex(g) };
  return pixCache.idx;
}

function paint(c: CoverageShown): HTMLCanvasElement {
  const L = rasterBounds!;
  const cv = document.createElement('canvas');
  cv.width = L.w; cv.height = L.hh;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(L.w, L.hh);
  const px = img.data;
  const idx = pixelIndex(c, L);
  const level = levelAt(c, lineOf(c, S.coverage.line));
  const nH = c.heights.length, HS = c.rays * c.res.samples;
  const sel = heightIndex(c.heights, S.droneH).i;
  const minh = S.coverage.show === 'minh' && nH >= 2; // из одной высоты «нужную» не выбрать — как в легенде
  const cOk = STATUS_RGB.ok, cWeak = STATUS_RGB.weak, cNone = STATUS_RGB.none;
  for (let p = 0, o = 0; p < idx.length; p++, o += 4) {
    const k = idx[p];
    if (k < 0) continue;
    if (!minh) {
      const lv = level(sel * HS + k);
      const cc = lv === 2 ? cOk : lv === 1 ? cWeak : cNone;
      px[o] = cc[0]; px[o + 1] = cc[1]; px[o + 2] = cc[2]; px[o + 3] = lv === 0 ? 70 : 255;
    } else {
      let hk = -1;
      for (let hi = 0; hi < nH; hi++) if (level(hi * HS + k) === 2) { hk = hi; break; }
      if (hk < 0) { px[o] = px[o + 1] = px[o + 2] = 128; px[o + 3] = 40; continue; }
      const col = PAL_RGB[paletteIndex(hk, nH, PAL_RGB.length)];
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function drawEdge(c: CoverageShown) {
  const hi = heightIndex(c.heights, S.droneH).i;
  const pts: [number, number][] = [];
  const ln = lineOf(c, S.coverage.line);
  for (let r = 0; r < c.rays; r++) {
    const q = destination(c.center, (360 * r) / c.rays, firstLossAt(c, ln, hi, r));
    pts.push([q.lon, q.lat]);
  }
  if (pts.length) pts.push(pts[0]);
  setGeo('cov-edge', fc(pts.length ? [line(pts)] : []));
}

/** Показать результат на карте (предварительный или окончательный). */
export function drawCoverage(c: CoverageShown): void {
  current = c;
  redrawCoverage();
}

function removeRaster() {
  if (map.getLayer('cov-raster')) map.removeLayer('cov-raster');
  if (map.getSource('cov')) map.removeSource('cov');
}

/**
 * Перерисовать текущий результат (сменились высота дрона, линия или режим закраски).
 * Растр — источником canvas: картинка уходит в текстуру как есть. Прежде она кодировалась в PNG (toBlob)
 * и снова декодировалась MapLibre — это было дольше самого расчёта зоны. Статичный canvas MapLibre читает
 * один раз, поэтому на каждую перерисовку источник создаётся заново (это дёшево).
 */
export function redrawCoverage(): void {
  if (!current) return;
  const c = current;
  rasterBounds = layoutRaster(c);
  const canvas = paint(c);
  removeRaster();
  map.addSource('cov', { type: 'canvas', canvas, coordinates: rasterBounds.coords, animate: false });
  map.addLayer({
    id: 'cov-raster', type: 'raster', source: 'cov',
    paint: { 'raster-opacity': S.coverage.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
  }, map.getLayer('cov-edge') ? 'cov-edge' : beforeOv());
  drawEdge(c);
}
