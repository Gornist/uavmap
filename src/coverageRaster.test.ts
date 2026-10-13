import { describe, expect, it } from 'vitest';
import { rasterIndex } from './coverageRaster';
import { bearing, destination, distance, lonLatToPixel, pixelToLonLat } from './geo';

describe('rasterIndex: та же геометрия, что distance/bearing на каждый пиксель', () => {
  for (const [lat, radius] of [[43.68, 10000], [60.2, 40000], [-33.9, 25000]] as const) {
    it(`широта ${lat}, радиус ${radius / 1000} км`, () => {
      const c = { lat, lon: 40.2 }, z = 20, rays = 360, step = radius / 400, samples = 401;
      const n = destination(c, 0, radius), s = destination(c, 180, radius), e = destination(c, 90, radius), w = destination(c, 270, radius);
      const [x0, y0] = lonLatToPixel(w.lon, n.lat, z), [x1, y1] = lonLatToPixel(e.lon, s.lat, z);
      const W = 160, H = Math.round((W * (y1 - y0)) / (x1 - x0));
      const idx = rasterIndex({ lat, lon: c.lon, radius, rays, step, samples, x0, y0, wx: x1 - x0, wy: y1 - y0, w: W, h: H, z });
      let bad = 0, inside = 0;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const [plon, plat] = pixelToLonLat(x0 + ((i + 0.5) * (x1 - x0)) / W, y0 + ((j + 0.5) * (y1 - y0)) / H, z);
        const p = { lat: plat, lon: plon }, d = distance(c, p), sIdx = Math.round(d / step);
        const ref = d > radius || sIdx >= samples ? -1 : (Math.round((bearing(c, p) / 360) * rays) % rays) * samples + sIdx;
        if (ref >= 0) inside++;
        if (idx[j * W + i] !== ref) bad++;
      }
      expect(inside).toBeGreaterThan(W * H * 0.7);
      expect(bad).toBe(0);
    });
  }
});
