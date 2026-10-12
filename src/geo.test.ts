import { describe, expect, it } from 'vitest';
import { bearing, destination, distance, fmtDist, interpolate, lonLatToPixel, pixelToLonLat, R_EARTH } from './geo';

const MSK = { lat: 55.7558, lon: 37.6173 };
const SPB = { lat: 59.9343, lon: 30.3351 };

describe('distance', () => {
  it('Москва–Санкт-Петербург ≈ 634 км (±1%; ортодромия по справочным данным 633–635 км)', () => {
    const d = distance(MSK, SPB) / 1000;
    expect(d).toBeGreaterThan(634 * 0.99);
    expect(d).toBeLessThan(634 * 1.01);
  });
  it('1° долготы на экваторе ≈ 111.2 км, 1° широты ≈ 111.2 км', () => {
    expect(distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) / 1000).toBeCloseTo(111.19, 1);
    expect(distance({ lat: 10, lon: 20 }, { lat: 11, lon: 20 }) / 1000).toBeCloseTo(111.19, 1);
  });
  it('нуль, симметрия, полуокружность', () => {
    expect(distance(MSK, MSK)).toBe(0);
    expect(distance(MSK, SPB)).toBeCloseTo(distance(SPB, MSK), 6);
    expect(distance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(Math.PI * R_EARTH, 3);
  });
  it('через антимеридиан: 179°→−179° на экваторе = 2°', () => {
    expect(distance({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }) / 1000).toBeCloseTo(2 * 111.19, 1);
  });
});

describe('bearing', () => {
  it('на север 0°, на восток ~90°, на юг 180°, на запад 270°', () => {
    const o = { lat: 50, lon: 30 };
    expect(bearing(o, { lat: 51, lon: 30 })).toBeCloseTo(0, 6);
    expect(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
    expect(bearing(o, { lat: 49, lon: 30 })).toBeCloseTo(180, 6);
    expect(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
  });
  it('Москва → СПб ≈ 319–320° (северо-запад)', () => {
    const b = bearing(MSK, SPB);
    expect(b).toBeGreaterThan(315);
    expect(b).toBeLessThan(325);
  });
  it('результат в [0, 360)', () => {
    for (const lon of [-170, -90, 0, 90, 170]) {
      const b = bearing({ lat: 10, lon: 0 }, { lat: -20, lon });
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe('destination ↔ distance/bearing', () => {
  it('туда-обратно: расстояние и азимут восстанавливаются', () => {
    for (const brg of [0, 33, 90, 135, 180, 222, 270, 359]) {
      for (const d of [10, 1000, 25000, 300000]) {
        const p = destination(MSK, brg, d);
        expect(distance(MSK, p)).toBeCloseTo(d, 2);
        const back = bearing(MSK, p);
        const diff = Math.abs(((back - brg + 540) % 360) - 180);
        expect(diff).toBeLessThan(1e-3);
      }
    }
  });
  it('0 м → та же точка; на север по меридиану долгота не меняется', () => {
    const p = destination(MSK, 77, 0);
    expect(p.lat).toBeCloseTo(MSK.lat, 9);
    expect(p.lon).toBeCloseTo(MSK.lon, 9);
    expect(destination(MSK, 0, 5000).lon).toBeCloseTo(MSK.lon, 9);
  });
  it('нормализует долготу в [−180, 180] за антимеридианом', () => {
    const p = destination({ lat: 0, lon: 179.5 }, 90, 111195);
    expect(p.lon).toBeCloseTo(-179.5, 2);
  });
});

describe('interpolate', () => {
  it('t=0 и t=1 → концы, t=0.5 → середина (равные расстояния)', () => {
    const a = interpolate(MSK, SPB, 0), b = interpolate(MSK, SPB, 1), m = interpolate(MSK, SPB, 0.5);
    expect(a.lat).toBeCloseTo(MSK.lat, 9);
    expect(a.lon).toBeCloseTo(MSK.lon, 9);
    expect(b.lat).toBeCloseTo(SPB.lat, 9);
    expect(b.lon).toBeCloseTo(SPB.lon, 9);
    expect(distance(MSK, m)).toBeCloseTo(distance(m, SPB), 3);
    expect(distance(MSK, m)).toBeCloseTo(distance(MSK, SPB) / 2, 3);
  });
  it('на экваторе — линейно по долготе; совпадающие точки не дают NaN', () => {
    const m = interpolate({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, 0.25);
    expect(m.lat).toBeCloseTo(0, 9);
    expect(m.lon).toBeCloseTo(2.5, 9);
    expect(interpolate(MSK, MSK, 0.5)).toEqual(MSK);
  });
});

describe('Web Mercator', () => {
  it('(0,0) на z=0 — центр тайла 256×256; весь мир = 256·2^z', () => {
    const [x, y] = lonLatToPixel(0, 0, 0);
    expect(x).toBeCloseTo(128, 9);
    expect(y).toBeCloseTo(128, 9);
    expect(lonLatToPixel(180, 0, 3)[0]).toBeCloseTo(256 * 8, 6);
  });
  it('номер тайла совпадает с формулой OSM slippy map (wiki.openstreetmap.org/wiki/Slippy_map_tilenames)', () => {
    const lat = 55.7558, lon = 37.6173, z = 10, n = 2 ** z, r = (lat * Math.PI) / 180;
    const tx = Math.floor(((lon + 180) / 360) * n);
    const ty = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    const [x, y] = lonLatToPixel(lon, lat, z);
    expect(tx).toBe(619);
    expect(Math.floor(x / 256)).toBe(tx);
    expect(Math.floor(y / 256)).toBe(ty);
  });
  it('туда-обратно на разных z', () => {
    for (const z of [0, 5, 12, 15, 18]) {
      for (const [lon, lat] of [[37.6173, 55.7558], [-122.4, 37.8], [151.2, -33.9], [0, 0], [179.9, 80]]) {
        const [px, py] = lonLatToPixel(lon, lat, z);
        const [lon2, lat2] = pixelToLonLat(px, py, z);
        expect(lon2).toBeCloseTo(lon, 7);
        expect(lat2).toBeCloseTo(lat, 7);
      }
    }
  });
  it('масштаб: 1 пиксель z=12 на 55.76°N ≈ 38.2·cos(φ) м', () => {
    const [x, y] = lonLatToPixel(37.6173, 55.7558, 12);
    const [lon2] = pixelToLonLat(x + 1, y, 12);
    const m = distance({ lat: 55.7558, lon: 37.6173 }, { lat: 55.7558, lon: lon2 });
    expect(m).toBeCloseTo((40075016.7 / (256 * 4096)) * Math.cos((55.7558 * Math.PI) / 180), 1);
  });
});

describe('fmtDist', () => {
  it('метры, километры с разной точностью', () => {
    expect(fmtDist(0)).toBe('0 м');
    expect(fmtDist(999.4)).toBe('999 м');
    expect(fmtDist(1000)).toBe('1.00 км');
    expect(fmtDist(9999)).toBe('10.00 км');
    expect(fmtDist(12345)).toBe('12.3 км');
    expect(fmtDist(634000)).toBe('634.0 км');
  });
});
