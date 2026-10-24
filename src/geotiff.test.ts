import { describe, it, expect } from 'vitest';
import { zlibSync } from 'fflate';
import { readGeoTiff, crsOf } from './geotiff';
import type { ByteSource } from './mymapsCore';
import { toUTM, toSK42InZone } from './coords';

// ---------- Мини-писатель GeoTIFF для тестов (little-endian, классический TIFF) ----------
type Tag = [tag: number, type: number, values: number[] | string];
interface Img { w: number; h: number; vals: (x: number, y: number) => number; fmt?: 'i16' | 'f32' | 'u8'; comp?: 1 | 5 | 8; pred?: 1 | 2 | 3; tile?: number; extra?: Tag[]; sub?: number }

const SZ: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

/** LZW-кодер TIFF (с «ранней» сменой ширины, как libtiff) — чтобы проверить декодер. */
function lzwEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0, nb = 0, width = 9;
  const put = (c: number) => { acc = (acc << width) | c; nb += width; while (nb >= 8) { out.push((acc >>> (nb - 8)) & 255); nb -= 8; } acc &= (1 << nb) - 1; };
  let dict = new Map<string, number>(), next = 258;
  const reset = () => { dict = new Map(); for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i); next = 258; width = 9; };
  reset(); put(256);
  let w = '';
  for (const b of src) {
    const c = String.fromCharCode(b), wc = w + c;
    if (dict.has(wc)) { w = wc; continue; }
    put(dict.get(w)!);
    dict.set(wc, next++);
    // Как LZWEncode в libtiff: таблица полна (4094) — код очистки; иначе ширина растёт, когда следующий код не влезает.
    if (next === 4094) { put(256); reset(); } else if (next > (1 << width) - 1) width++;
    w = c;
  }
  if (w) put(dict.get(w)!);
  put(257);
  if (nb) out.push((acc << (8 - nb)) & 255);
  return Uint8Array.from(out);
}

function encodeBlock(img: Img, x0: number, y0: number, bw: number, bh: number): Uint8Array {
  const bytes = img.fmt === 'f32' ? 4 : img.fmt === 'u8' ? 1 : 2;
  const buf = new Uint8Array(bw * bh * bytes), dv = new DataView(buf.buffer);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const v = x0 + x < img.w && y0 + y < img.h ? img.vals(x0 + x, y0 + y) : 0, o = (y * bw + x) * bytes;
    if (bytes === 4) dv.setFloat32(o, v, true); else if (bytes === 1) dv.setUint8(o, v); else dv.setInt16(o, v, true);
  }
  if (img.pred === 2) for (let y = 0; y < bh; y++) for (let x = bw - 1; x > 0; x--) {
    const o = (y * bw + x) * bytes;
    if (bytes === 2) dv.setInt16(o, dv.getInt16(o, true) - dv.getInt16(o - 2, true), true); else dv.setUint8(o, (dv.getUint8(o) - dv.getUint8(o - 1)) & 255);
  }
  if (img.pred === 3) for (let y = 0; y < bh; y++) {
    const row = buf.subarray(y * bw * 4, (y + 1) * bw * 4), copy = row.slice();
    for (let i = 0; i < bw; i++) for (let b = 0; b < 4; b++) row[(4 - b - 1) * bw + i] = copy[i * 4 + b];
    for (let i = row.length - 1; i > 0; i--) row[i] = (row[i] - row[i - 1]) & 255;
  }
  return img.comp === 8 ? zlibSync(buf) : img.comp === 5 ? lzwEncode(buf) : buf;
}

/** IFD-описание растра; geo — теги геопривязки (только у полного). */
function ifdTags(img: Img, offs: number[], cnts: number[], geo: Tag[]): Tag[] {
  const bits = img.fmt === 'f32' ? 32 : img.fmt === 'u8' ? 8 : 16;
  const t: Tag[] = [[256, 4, [img.w]], [257, 4, [img.h]], [258, 3, [bits]], [259, 3, [img.comp ?? 1]], [262, 3, [1]], [277, 3, [1]],
    [339, 3, [img.fmt === 'f32' ? 3 : img.fmt === 'u8' ? 1 : 2]], [317, 3, [img.pred ?? 1]], ...geo, ...(img.extra ?? [])];
  if (img.sub) t.push([254, 4, [img.sub]]);
  if (img.tile) t.push([322, 3, [img.tile]], [323, 3, [img.tile]], [324, 4, offs], [325, 4, cnts]);
  else t.push([278, 4, [img.h]], [273, 4, offs], [279, 4, cnts]);
  return t.sort((a, b) => a[0] - b[0]);
}

function writeTiff(imgs: Img[], geo: Tag[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 8;
  const add = (b: Uint8Array) => { const at = pos; parts.push(b); pos += b.length + (b.length & 1); if (b.length & 1) parts.push(new Uint8Array(1)); return at; };
  const ifdAt: number[] = [], ifdBufs: { at: number; dv: DataView; nextAt: number }[] = [];
  for (const [k, img] of imgs.entries()) {
    const bw = img.tile ?? img.w, bh = img.tile ?? img.h, offs: number[] = [], cnts: number[] = [];
    for (let y = 0; y < img.h; y += bh) for (let x = 0; x < img.w; x += bw) { const b = encodeBlock(img, x, y, bw, img.tile ? bh : Math.min(bh, img.h - y)); offs.push(add(b)); cnts.push(b.length); }
    const tags = ifdTags(img, offs, cnts, k === 0 ? geo : []);
    // Значения, не влезающие в 4 байта, — отдельно, перед IFD.
    const vals = tags.map(([, type, v]) => {
      const n = typeof v === 'string' ? v.length + 1 : v.length, size = SZ[type] * n;
      if (size <= 4) return null;
      const b = new Uint8Array(size), d = new DataView(b.buffer);
      if (typeof v === 'string') for (let i = 0; i < v.length; i++) b[i] = v.charCodeAt(i);
      else v.forEach((x, i) => (type === 3 ? d.setUint16(i * 2, x, true) : type === 4 ? d.setUint32(i * 4, x, true) : d.setFloat64(i * 8, x, true)));
      return add(b);
    });
    const ib = new Uint8Array(2 + tags.length * 12 + 4), d = new DataView(ib.buffer);
    d.setUint16(0, tags.length, true);
    tags.forEach(([tag, type, v], i) => {
      const e = 2 + i * 12, n = typeof v === 'string' ? v.length + 1 : v.length;
      d.setUint16(e, tag, true); d.setUint16(e + 2, type, true); d.setUint32(e + 4, n, true);
      if (vals[i] !== null) d.setUint32(e + 8, vals[i]!, true);
      else if (typeof v === 'string') for (let j = 0; j < v.length; j++) d.setUint8(e + 8 + j, v.charCodeAt(j));
      else v.forEach((x, j) => (type === 3 ? d.setUint16(e + 8 + j * 2, x, true) : d.setUint32(e + 8, x, true)));
    });
    const at = add(ib);
    ifdAt.push(at); ifdBufs.push({ at, dv: d, nextAt: 2 + tags.length * 12 });
  }
  ifdBufs.forEach((b, i) => b.dv.setUint32(b.nextAt, ifdAt[i + 1] ?? 0, true));
  const out = new Uint8Array(pos), dv = new DataView(out.buffer);
  out.set([0x49, 0x49]); dv.setUint16(2, 42, true); dv.setUint32(4, ifdAt[0], true);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Геопривязка: угол (x0, y0), шаг (sx, sy), система координат. */
const geoTags = (x0: number, y0: number, sx: number, sy: number, epsg: number, geographic: boolean, point = false): Tag[] => [
  [33550, 12, [sx, sy, 0]], [33922, 12, [0, 0, 0, x0, y0, 0]],
  [34735, 3, [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, point ? 2 : 1, geographic ? 2048 : 3072, 0, 1, epsg]],
];

const src = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (o, n) => b.slice(o, o + n).buffer });

/** Рельеф-плоскость: высота = 100 + 2·x − y (м), чтобы билинейная интерполяция была точной. */
const plane = (x: number, y: number) => 100 + 2 * x - y;

describe('GeoTIFF: чтение высот', () => {
  for (const [name, img] of [
    ['int16 без сжатия, полосой', { w: 40, h: 30, vals: plane }],
    ['int16 Deflate + предсказатель 2, тайлы 16', { w: 40, h: 30, vals: plane, comp: 8, pred: 2, tile: 16 }],
    ['int16 LZW, полосой (коды до 12 бит)', { w: 120, h: 90, vals: (x: number, y: number) => (x * 37 + y * 101) % 3000, comp: 5 }],
    ['float32 Deflate + предсказатель 3', { w: 40, h: 30, vals: plane, fmt: 'f32', comp: 8, pred: 3 }],
  ] as [string, Img][]) {
    it(name, async () => {
      const g = await readGeoTiff(src(writeTiff([img], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true))));
      expect([g.w, g.h]).toEqual([img.w, img.h]);
      for (const [x, y] of [[0, 0], [img.w - 1, img.h - 1], [7, 11], [33 % img.w, 4]]) expect(g.data[y * img.w + x]).toBe(Math.round(img.vals(x, y)));
      expect(g.crs).toMatch(/WGS-84/);
    });
  }

  it('широта/долгота: границы, высота в точке между пикселями, вне растра — null', async () => {
    const g = await readGeoTiff(src(writeTiff([{ w: 40, h: 30, vals: plane }], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true))));
    expect(g.bounds.map((v) => +v.toFixed(6))).toEqual([37, 55.97, 37.04, 56]);
    // центр пикселя (10, 5) — 37.0105, 55.9945; посередине между (10,5) и (11,6):
    expect(g.height(55.9945 - 0.0005, 37.0105 + 0.0005)).toBeCloseTo(plane(10.5, 5.5), 6);
    expect(g.height(56.01, 37.02)).toBeNull();
    expect(g.stepM).toBeGreaterThan(55); expect(g.stepM).toBeLessThan(70);
  });

  it('PixelIsPoint: координата тайпойнта — центр пикселя', async () => {
    const g = await readGeoTiff(src(writeTiff([{ w: 40, h: 30, vals: plane }], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true, true))));
    expect(g.height(56.0, 37.0)).toBeCloseTo(plane(0, 0), 6);
    expect(g.height(55.995, 37.003)).toBeCloseTo(plane(3, 5), 6);
  });

  it('UTM 37N: точка переводится в метры зоны', async () => {
    const o = toUTM(55.75, 37.6, 37, false);
    const x0 = Math.round(o.e), y0 = Math.round(o.n);
    const g = await readGeoTiff(src(writeTiff([{ w: 50, h: 50, vals: plane }], geoTags(x0, y0, 30, 30, 32637, false))));
    const p = toUTM(g.bounds[1] + 0.003, g.bounds[0] + 0.003, 37, false);
    const px = (p.e - x0) / 30 - 0.5, py = (y0 - p.n) / 30 - 0.5;
    expect(g.height(g.bounds[1] + 0.003, g.bounds[0] + 0.003)).toBeCloseTo(plane(px, py), 4);
    expect(g.crs).toMatch(/UTM 37N/);
    expect(g.stepM).toBe(30);
  });

  it('СК-42 зона 7 (EPSG:28407)', async () => {
    const o = toSK42InZone(55.75, 37.6, 7);
    const g = await readGeoTiff(src(writeTiff([{ w: 50, h: 50, vals: plane }], geoTags(Math.round(o.y), Math.round(o.x), 25, 25, 28407, false))));
    expect(g.height(55.75 - 0.002, 37.6 + 0.002)).not.toBeNull();
    expect(g.bounds[0]).toBeCloseTo(37.6, 2);
    expect(g.crs).toMatch(/СК-42, зона 7/);
  });

  it('большой растр — берётся уменьшенная копия (обзор), привязка масштабируется', async () => {
    const full: Img = { w: 64, h: 64, vals: plane, tile: 16 };
    const ov: Img = { w: 32, h: 32, vals: (x, y) => plane(2 * x + 0.5, 2 * y + 0.5), tile: 16, sub: 1 };
    const g = await readGeoTiff(src(writeTiff([full, ov], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true))), 2000);
    expect([g.w, g.h, g.reduced]).toEqual([32, 32, true]);
    expect(g.height(56 - 0.0205, 37 + 0.0105)).toBeCloseTo(plane(10, 20), 0); // центр пикселя (10, 20) полного
    await expect(readGeoTiff(src(writeTiff([full], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true))), 2000)).rejects.toThrow(/слишком большой/);
  });

  it('пропуски (NoData) заполняются, «одни пропуски» — отказ', async () => {
    const nd: Tag = [42113, 2, '-9999'];
    const g = await readGeoTiff(src(writeTiff([{ w: 10, h: 10, vals: (x, y) => (x === 5 && y === 5 ? -9999 : plane(x, y)), extra: [nd] }], geoTags(37, 56, 0.001, 0.001, 4326, true))));
    expect(g.data[5 * 10 + 5]).toBe(plane(5, 5));
    await expect(readGeoTiff(src(writeTiff([{ w: 10, h: 10, vals: () => -9999, extra: [nd] }], geoTags(37, 56, 0.001, 0.001, 4326, true))))).rejects.toThrow(/одни пропуски/);
  });

  it('понятные отказы: не TIFF, без привязки, чужая система координат', async () => {
    await expect(readGeoTiff(src(new Uint8Array(64)))).rejects.toThrow(/не TIFF/);
    const noGeo = writeTiff([{ w: 10, h: 10, vals: plane }], []);
    await expect(readGeoTiff(src(noGeo))).rejects.toThrow(/систем|геопривязк/);
    expect(() => crsOf(new Map([[1024, 1], [3072, 2154]]))).toThrow(/2154 не поддерживается/);
  });
});

describe('GeoTIFF: тайл высот для расчётов', () => {
  it('тайл внутри растра — высоты, на краю — null (берётся из сети)', async () => {
    const { synthFromGrid } = await import('./geotiff');
    // Растр 0,2°×0,2° у 56° с. ш. с шагом 0,0005°.
    const g = await readGeoTiff(src(writeTiff([{ w: 400, h: 400, vals: plane, tile: 64 }], geoTags(37.0, 56.0, 0.0005, 0.0005, 4326, true))));
    // z14: тайл ~2,4 км; центр растра — 37,1° в. д., 55,9° с. ш.
    const z = 14, N = 2 ** z;
    const tx = Math.floor(((37.1 + 180) / 360) * N);
    const ty = Math.floor(((1 - Math.log(Math.tan((55.9 * Math.PI) / 180) + 1 / Math.cos((55.9 * Math.PI) / 180)) / Math.PI) / 2) * N);
    const t = synthFromGrid(z, tx, ty, g)!;
    expect(t).not.toBeNull();
    expect(t.length).toBe(256 * 256);
    expect(Math.min(...t)).toBeGreaterThan(-500);
    // Тайл, задевающий западный край растра (37,0°), — не наш.
    expect(synthFromGrid(z, Math.floor(((37.0 + 180) / 360) * N), ty, g)).toBeNull();
  });
});

describe('GeoTIFF: датум и повреждённые файлы', () => {
  it('широта/долгота СК-42 (EPSG:4284) — со сдвигом датума; чужой датум — отказ', async () => {
    const g = await readGeoTiff(src(writeTiff([{ w: 40, h: 30, vals: plane }], geoTags(37.0, 56.0, 0.001, 0.001, 4284, true))));
    expect(g.crs).toMatch(/4284/);
    // Угол растра в СК-42 (37°, 56°) в WGS-84 — на 100–200 м в стороне: границы не совпадают с «сырыми» числами.
    expect(Math.abs(g.bounds[0] - 37) * 111320 * Math.cos((56 * Math.PI) / 180)).toBeGreaterThan(50);
    expect(() => crsOf(new Map([[1024, 2], [2048, 4230]]))).toThrow(/4230 не поддерживается/);
  });
  it('обрезанный блок — отказ, а не нули', async () => {
    const lzwFile = writeTiff([{ w: 40, h: 30, vals: plane, comp: 5 }], geoTags(37.0, 56.0, 0.001, 0.001, 4326, true));
    expect((await readGeoTiff(src(lzwFile))).w).toBe(40);
    // Поток LZW полосы (с 8-го байта) обрывается раньше времени: в середину вписан код конца (257 в 9 битах).
    const cut = lzwFile.slice();
    cut[8 + 200] = 0x80; cut[8 + 201] = 0x40; cut[8 + 202] = 0x00;
    await expect(readGeoTiff(src(cut))).rejects.toThrow(/короче|LZW/);
  });
});

describe('GeoTIFF: цветная картинка — не рельеф', () => {
  it('RGB (три полосы) — отказ', async () => {
    const rgb = writeTiff([{ w: 10, h: 10, vals: () => 120, fmt: 'u8', extra: [[262, 3, [2]]] }], geoTags(37, 56, 0.001, 0.001, 4326, true));
    // Писатель ставит SamplesPerPixel = 1 и Photometric = 1; фотометрию RGB подменяем тегом extra — он идёт после.
    await expect(readGeoTiff(src(rgb))).rejects.toThrow(/цветная картинка/);
  });
});

describe('GeoTIFF: ловушки на память', () => {
  it('огромный объявленный тайл — отказ до распаковки', async () => {
    const t = writeTiff([{ w: 32, h: 32, vals: plane, tile: 16 }], geoTags(37, 56, 0.001, 0.001, 4326, true));
    // Подменяем TileWidth (тег 322, SHORT = 16) на 65535 прямо в IFD.
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (dv.getUint16(e, true) === 322) dv.setUint16(e + 8, 65535, true); }
    await expect(readGeoTiff(src(t))).rejects.toThrow(/размер тайла/);
  });
});
