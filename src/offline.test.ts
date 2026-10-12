import { describe, it, expect, vi } from 'vitest';
vi.mock('./app', () => ({ S: {}, map: {}, center: () => ({ lat: 0, lon: 0 }), openSheet: () => document, progress: () => {}, toast: () => {}, h: () => ({}), escapeHtml: (t: string) => t, fc: () => ({}), setGeo: () => {} }));
import { tileRange, enumerateTiles, countTiles, estimateBytes, planLayers, parseAreas, exclusiveKeys, tileKey, tileUrl, keyToUrl, Area, DEFAULT_TILE_BYTES } from './offline';

const area = (id: string, lat: number, lon: number, km: number, z = [10]): Area => ({
  id, name: id, lat, lon, km, calc: true, view: false, layers: z.map((zz) => ({ z: zz, km })), tiles: 1, bytes: 1, ts: 1,
});

describe('перечисление тайлов', () => {
  it('без дублей и все в диапазоне', () => {
    const t = enumerateTiles(50, 30, [{ z: 12, km: 10 }, { z: 12, km: 5 }, { z: 11, km: 10 }]);
    const keys = t.map(tileKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of t) { expect(x.x).toBeGreaterThanOrEqual(0); expect(x.x).toBeLessThan(2 ** x.z); }
  });
  it('число тайлов растёт с радиусом и зумом', () => {
    expect(countTiles(50, 30, 20, 12)).toBeGreaterThan(countTiles(50, 30, 10, 12));
    expect(countTiles(50, 30, 10, 13)).toBeGreaterThan(countTiles(50, 30, 10, 12) * 3);
  });
  it('обёртка по X через антимеридиан', () => {
    const t = enumerateTiles(60, 179.9, [{ z: 8, km: 40 }]);
    const xs = new Set(t.map((v) => v.x));
    expect(xs.has(255)).toBe(true);
    expect(xs.has(0)).toBe(true);
    expect(t.length).toBe(new Set(t.map(tileKey)).size);
  });
  it('обрезка по Y у полюса', () => {
    const t = enumerateTiles(85, 0, [{ z: 6, km: 100 }]);
    expect(Math.min(...t.map((v) => v.y))).toBe(0);
    expect(t.every((v) => v.y >= 0 && v.y < 64)).toBe(true);
  });
  it('огромный радиус не даёт больше 2^z колонок', () => {
    const r = tileRange(0, 0, 40000, 3);
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(8);
  });
  it('URL тайла по шаблону DEM', () => {
    expect(tileUrl({ z: 3, x: 4, y: 5 })).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/3/4/5.png');
    expect(keyToUrl('3/4/5')).toBe(tileUrl({ z: 3, x: 4, y: 5 }));
  });
});

describe('оценка и план', () => {
  it('объём', () => {
    expect(estimateBytes(100)).toBe(100 * DEFAULT_TILE_BYTES);
    expect(estimateBytes(10, 1000)).toBe(10000);
  });
  it('слои расчёта и карты', () => {
    const l = planLayers(50, 10, true, true);
    expect(l.some((x) => x.z === 8) && l.some((x) => x.z === 13)).toBe(true);
    expect(planLayers(50, 10, false, false)).toEqual([]);
    const keys = l.map((x) => `${x.z}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('растёт с радиусом на широтах 45 и 55', () => {
    for (const lat of [45, 55]) {
      const n = [5, 10, 20, 40].map((km) => enumerateTiles(lat, 30, planLayers(lat, km, true, true)).length);
      expect(n[0]).toBeLessThan(n[1]); expect(n[1]).toBeLessThan(n[2]); expect(n[2]).toBeLessThan(n[3]);
    }
  });
});

describe('удаление только неиспользуемых', () => {
  it('одинокий район удаляется целиком', () => {
    const a = area('a', 50, 30, 10);
    expect(exclusiveKeys(a, []).length).toBe(enumerateTiles(50, 30, a.layers).length);
  });
  it('пересечение остаётся', () => {
    const a = area('a', 50, 30, 10), b = area('b', 50, 30.1, 10);
    const ka = enumerateTiles(50, 30, a.layers).map(tileKey), kb = new Set(enumerateTiles(50, 30.1, b.layers).map(tileKey));
    const ex = exclusiveKeys(a, [b]);
    expect(ex.length).toBeLessThan(ka.length);
    expect(ex.every((k) => !kb.has(k))).toBe(true);
    expect(ex.length).toBe(ka.filter((k) => !kb.has(k)).length);
  });
  it('полностью перекрытый район ничего не удаляет', () => {
    expect(exclusiveKeys(area('a', 50, 30, 5), [area('b', 50, 30, 10)])).toEqual([]);
  });
});

describe('разбор метаданных', () => {
  const ok = area('a', 50, 30, 10);
  it('нормальные записи', () => {
    expect(parseAreas(JSON.stringify({ v: 1, areas: [ok] }))).toEqual([ok]);
  });
  it('мусор', () => {
    expect(parseAreas(null)).toEqual([]);
    expect(parseAreas('{{')).toEqual([]);
    expect(parseAreas('42')).toEqual([]);
    expect(parseAreas(JSON.stringify({ areas: 5 }))).toEqual([]);
  });
  it('повреждённые записи отбрасываются, дубли id тоже', () => {
    const bad = [
      null, 1, 'x', { ...ok, id: '' }, { ...ok, id: 'b', lat: 95 }, { ...ok, id: 'c', km: -1 },
      { ...ok, id: 'd', layers: [] }, { ...ok, id: 'e', layers: [{ z: 99, km: 1 }] }, { ...ok, id: 'f', tiles: 'many' },
      { ...ok, id: 'g', lon: NaN }, ok,
    ];
    expect(parseAreas(JSON.stringify({ areas: bad })).map((x) => x.id)).toEqual(['a']);
    expect(parseAreas(JSON.stringify([ok, ok])).length).toBe(1);
  });
});
