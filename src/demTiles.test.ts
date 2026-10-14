import { describe, expect, it } from 'vitest';
import { DEM_PREFIX, DEM_URL, demTileCount, demTileSpan, demTileUrl, srcOf } from './demTiles';
import { lonLatToPixel } from './geo';

describe('demTiles', () => {
  it('адрес тайла и префикс для Service Worker', () => {
    expect(demTileUrl(3, 4, 5)).toBe('https://tiles.mapterhorn.com/3/4/5.webp');
    expect(DEM_URL.startsWith(DEM_PREFIX)).toBe(true);
    expect(demTileUrl(12, 1, 2).startsWith(DEM_PREFIX)).toBe(true);
    expect(DEM_PREFIX).toBe('https://tiles.mapterhorn.com/');
  });
  it('виртуальный тайл 256 px → тайл источника 512 px уровнем выше и четверть в нём', () => {
    expect(srcOf(13, 5013, 2989)).toEqual({ z: 12, x: 2506, y: 1494, qx: 1, qy: 1 });
    expect(srcOf(13, 5012, 2988)).toEqual({ z: 12, x: 2506, y: 1494, qx: 0, qy: 0 });
    expect(srcOf(1, 1, 0)).toEqual({ z: 0, x: 0, y: 0, qx: 1, qy: 0 });
  });
  it('одна точка — один тайл; запас у границы тайла добавляет соседний', () => {
    const p = { lat: 43.68, lon: 40.2 };
    expect(demTileCount([p], 12)).toBe(1);
    const [x, y] = lonLatToPixel(p.lon, p.lat, 12);
    const s = demTileSpan([p], 12);
    expect(s.tx0).toBe(Math.floor(x / 256));
    expect(s.ty0).toBe(Math.floor(y / 256));
    // запас больше тайла — с каждой стороны ещё по тайлу
    expect(demTileCount([p], 12, 256)).toBe(9);
  });
  it('прямоугольник по углам: счёт = (колонки) × (строки)', () => {
    const nw = { lat: 44, lon: 40 }, se = { lat: 43.5, lon: 40.6 };
    const s = demTileSpan([nw, se], 11, 2);
    expect(demTileCount([nw, se], 11, 2)).toBe((s.tx1 - s.tx0 + 1) * (s.ty1 - s.ty0 + 1));
    expect(demTileCount([se, nw], 11, 2)).toBe(demTileCount([nw, se], 11, 2)); // порядок точек не важен
  });
});
