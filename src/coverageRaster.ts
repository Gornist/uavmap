// Геометрия растра зоны: какой отсчёт (луч, расстояние) показывать в каждом пикселе.
import { pixelToLonLat, R_EARTH, D2R } from './geo';

export interface RasterGeom {
  lat: number; lon: number;           // пульт
  radius: number; rays: number; step: number; samples: number;
  x0: number; y0: number; wx: number; wy: number; // окно растра в глобальных пикселях уровня z
  w: number; h: number; z: number;    // размер растра, px
}

/**
 * Для каждого пикселя (строка j, столбец i) — индекс r·samples + s или −1 вне круга. Формулы те же, что
 * distance/bearing в geo.ts (haversine, начальный азимут), но широта постоянна по строке, долгота — по столбцу,
 * поэтому тригонометрия вынесена из внутреннего цикла: остаются sqrt, asin и atan2.
 */
export function rasterIndex(g: RasterGeom): Int32Array {
  const idx = new Int32Array(g.w * g.h).fill(-1);
  const f1 = g.lat * D2R, cf1 = Math.cos(f1), sf1 = Math.sin(f1);
  const C = new Float64Array(g.w), sdl = new Float64Array(g.w), cdl = new Float64Array(g.w);
  for (let i = 0; i < g.w; i++) {
    const lon = pixelToLonLat(g.x0 + ((i + 0.5) * g.wx) / g.w, g.y0, g.z)[0];
    const dl = (lon - g.lon) * D2R;
    C[i] = Math.sin(dl / 2) ** 2; sdl[i] = Math.sin(dl); cdl[i] = Math.cos(dl);
  }
  const R2 = 2 * R_EARTH;
  for (let j = 0; j < g.h; j++) {
    const lat = pixelToLonLat(g.x0, g.y0 + ((j + 0.5) * g.wy) / g.h, g.z)[1];
    const f2 = lat * D2R, cf2 = Math.cos(f2), sf2 = Math.sin(f2);
    const A = Math.sin(((lat - g.lat) * D2R) / 2) ** 2, B = cf1 * cf2;
    const xa = cf1 * sf2, xb = sf1 * cf2;
    for (let i = 0; i < g.w; i++) {
      const d = R2 * Math.asin(Math.min(1, Math.sqrt(A + B * C[i])));            // geo.distance
      const s = Math.round(d / g.step);
      if (d > g.radius || s >= g.samples) continue;
      const brg = (Math.atan2(sdl[i] * cf2, xa - xb * cdl[i]) / D2R + 360) % 360; // geo.bearing
      idx[j * g.w + i] = (Math.round((brg / 360) * g.rays) % g.rays) * g.samples + s;
    }
  }
  return idx;
}
