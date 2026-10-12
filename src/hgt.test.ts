import { describe, it, expect } from 'vitest';
import { parseHgtName, hgtSideFromSize, checkHgtFile, HgtTile, HGT_VOID, tileBounds, cellsForTile, tileCoverage, synthTile } from './hgt';

/** Синтетическая ячейка: высота = f(строка, столбец), big-endian. */
function makeBuf(n: number, f: (r: number, c: number) => number): ArrayBuffer {
  const b = new ArrayBuffer(n * n * 2), dv = new DataView(b);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dv.setInt16((r * n + c) * 2, f(r, c), false);
  return b;
}
// Плоскость, растущая на восток и на север: h = 100·(lon−lon0) + 200·(lat−lat0), в метрах.
const plane = (n: number) => (r: number, c: number) => Math.round((100 * c) / (n - 1) + (200 * (n - 1 - r)) / (n - 1));

describe('имя и размер', () => {
  it('привязка по имени N/S/E/W', () => {
    expect(parseHgtName('N55E037.hgt')).toEqual({ lat: 55, lon: 37 });
    expect(parseHgtName('s12w077.HGT')).toEqual({ lat: -12, lon: -77 });
    expect(parseHgtName('N00E000.hgt')).toEqual({ lat: 0, lon: 0 });
    for (const bad of ['55E037.hgt', 'N55E37.hgt', 'N55E037.hgt.zip', 'N55E037.tif', '../N55E037.hgt', 'N95E037.hgt', 'N55E180.hgt', 'N55E037.hgtx']) expect(parseHgtName(bad)).toBeNull();
  });
  it('размеры строго 1201² и 3601²', () => {
    expect(hgtSideFromSize(1201 * 1201 * 2)).toBe(1201);
    expect(hgtSideFromSize(3601 * 3601 * 2)).toBe(3601);
    expect(hgtSideFromSize(1201 * 1201 * 2 + 1)).toBeNull();
    expect(checkHgtFile('N55E037.hgt', 1201 * 1201 * 2)).toBeNull();
    expect(checkHgtFile('N55E037.hgt', 31 * 1024 * 1024)).toMatch(/30 МБ/);
    expect(checkHgtFile('foo.hgt', 1201 * 1201 * 2)).toMatch(/Имя/);
    expect(() => HgtTile.fromBuffer('N55E037.hgt', new ArrayBuffer(100))).toThrow();
  });
});

describe('разбор и высота', () => {
  const n = 1201;
  const t = HgtTile.fromBuffer('N55E037.hgt', makeBuf(n, plane(n)));
  it('big-endian и углы', () => {
    expect(t.data[0]).toBe(200); // северо-запад
    expect(t.data[n - 1]).toBe(300); // северо-восток
    expect(t.data[(n - 1) * n]).toBe(0); // юго-запад
    expect(t.height(55, 37)).toBeCloseTo(0, 6);
    expect(t.height(56, 38)).toBeCloseTo(300, 6);
  });
  it('билинейка между узлами и зажим за краем', () => {
    expect(t.height(55.5, 37.5)).toBeCloseTo(150, 0);
    expect(t.height(55.25, 37.75)).toBeCloseTo(75 + 50, 0);
    expect(t.height(54, 36)).toBeCloseTo(0, 6);
    expect(t.height(57, 39)).toBeCloseTo(300, 6);
  });
  it('пропуски −32768 заполняются соседями', () => {
    const b = makeBuf(n, () => 100);
    const dv = new DataView(b);
    for (let c = 10; c < 20; c++) dv.setInt16((5 * n + c) * 2, HGT_VOID, false);
    for (let c = 0; c < n; c++) dv.setInt16((7 * n + c) * 2, HGT_VOID, false); // строка целиком
    const v = HgtTile.fromBuffer('N10E010.hgt', b);
    expect(v.voids).toBe(10 + n);
    expect(v.data.every((x) => x === 100)).toBe(true);
  });
  it('ячейка целиком без данных отвергается', () => {
    expect(() => HgtTile.fromBuffer('N10E010.hgt', makeBuf(n, () => HGT_VOID))).toThrow(/без данных/);
  });
});

describe('покрытие и синтез тайла', () => {
  const n = 1201;
  const cells = new Map<string, HgtTile>();
  for (const [la, lo] of [[55, 37], [55, 38], [56, 37], [56, 38]]) {
    // глобально согласованная поверхность: h = 100·lon_frac + 200·lat_frac в пределах ячейки, разная база по ячейкам
    const base = (la - 55) * 1000 + (lo - 37) * 3000;
    cells.set(`${la},${lo}`, HgtTile.fromBuffer(`N${la}E0${lo}.hgt`, makeBuf(n, (r, c) => base + plane(n)(r, c))));
  }
  const has = (la: number, lo: number) => cells.has(`${la},${lo}`);

  it('границы и ячейки тайла', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBe(-180); expect(b.east).toBe(180); expect(b.north).toBeCloseTo(85.05, 1);
    // z12 в районе 55.5N 37.5E целиком внутри одной ячейки
    const N = 4096, x = Math.floor(((37.5 + 180) / 360) * N), y = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + (55.5 * Math.PI) / 360)) / (2 * Math.PI)) * N);
    expect(cellsForTile(12, x, y)).toEqual([[55, 37]]);
    expect(cellsForTile(2, 0, 0)).toBeNull(); // слишком большой тайл
  });
  it('покрытие: все ячейки должны быть', () => {
    // z9 тайл на стыке 4 ячеек (55.6N..56.2N не обязательно) — подберём по границе lat 56 / lon 38
    const z = 12, N = 2 ** z;
    const x = Math.floor(((38 + 180) / 360) * N), y = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + (56 * Math.PI) / 360)) / (2 * Math.PI)) * N);
    const need = cellsForTile(z, x, y)!;
    expect(need.length).toBeGreaterThanOrEqual(2);
    expect(tileCoverage(z, x, y, has)).not.toBeNull();
    expect(tileCoverage(z, x, y, (la, lo) => has(la, lo) && !(la === 56 && lo === 38))).toBeNull();
    expect(tileCoverage(z, x, y, () => false)).toBeNull();
  });
  it('синтез: значения совпадают с HGT в узлах, шов между ячейками гладкий', () => {
    const z = 12, N = 2 ** z;
    const x = Math.floor(((37.5 + 180) / 360) * N), y = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + (55.5 * Math.PI) / 360)) / (2 * Math.PI)) * N);
    const tile = synthTile(z, x, y, (la, lo) => cells.get(`${la},${lo}`))!;
    expect(tile.length).toBe(65536);
    const t = cells.get('55,37')!;
    for (const [r, c] of [[0, 0], [100, 200], [255, 255], [128, 3]]) {
      const lon = ((x * 256 + c + 0.5) / (256 * N)) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * 256 + r + 0.5)) / (256 * N)))) * 180) / Math.PI;
      expect(tile[r * 256 + c]).toBeCloseTo(t.height(lat, lon), 3);
      // и плоскость: 100·(lon−37)+200·(lat−55)
      expect(tile[r * 256 + c]).toBeCloseTo(100 * (lon - 37) + 200 * (lat - 55), 0);
    }
    expect(synthTile(z, x, y, () => undefined)).toBeNull();
  });
});
