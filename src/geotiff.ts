// Свой рельеф из GeoTIFF: одна полоса высот (целые или с плавающей точкой), без сжатия, LZW, Deflate или PackBits,
// тайлами или полосами, с предсказателем 1/2/3. Системы координат: широта/долгота (EPSG:4326 и другие
// географические), Web Mercator (3857), UTM WGS-84 (326xx/327xx), СК-42 Гаусса–Крюгера (284xx, восток с номером зоны).
// Растр больше MAX_PX — берём его уменьшенную копию (обзор COG), если она есть. Высоты — в Int16 (метры), как у HGT.
// Чистая логика без DOM: файл читается кусками через ByteSource (mymapsCore.ts).
import { unzlibSync, inflateSync } from 'fflate';
import type { ByteSource } from './mymapsCore';
import { HGT_VOID, fillVoids } from './hgt';
import { toSK42InZone, toUTM, fromSK42, wgsToSk42Geo, sk42GeoToWgs } from './coords';

/** Предел пикселей в памяти: 16 Мп × 2 байта = 32 МБ (как пара ячеек SRTM 1″). */
export const MAX_PX = 16e6;
/** Предел размера файла (читаются только нужные блоки, но OPFS и копирование — целиком). */
export const TIF_MAX_BYTES = 1024 ** 3;

const R_MERC = 6378137;
/** Географические системы, совпадающие с WGS-84 в пределах шага рельефа: WGS-84 (2D/3D), ETRS89, NAD83, ITRF/ГСК-2011. */
const WGS_LIKE = [4326, 4979, 4258, 4269, 7844, 7683];

/** Пересчёт широты/долготы в координаты растра (X — восток, Y — север) и описание для пользователя. */
interface Crs { name: string; geographic: boolean; fwd: (lat: number, lon: number) => [number, number]; inv: (x: number, y: number) => [number, number] }

export interface TifGrid {
  w: number; h: number;
  /** Высоты, м, строка 0 — верхняя; пропуски заполнены. */
  data: Int16Array;
  /** [запад, юг, восток, север], градусы (по углам растра). */
  bounds: [number, number, number, number];
  crs: string;
  /** Непрерывные координаты пикселя (центр пикселя (0,0) = 0) или null — точка вне растра. */
  pix(lat: number, lon: number): [number, number] | null;
  /** Билинейная высота, м, или null вне растра. */
  height(lat: number, lon: number): number | null;
  /** Шаг сетки, м (примерно, по центру). */
  stepM: number;
  /** Растр был уменьшен (взята уменьшенная копия). */
  reduced: boolean;
}

// ---------- TIFF ----------
interface Ifd { tags: Map<number, number[] | string> }

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

class Reader {
  le = true;
  constructor(private src: ByteSource) {}
  async dv(off: number, n: number): Promise<DataView> {
    if (off < 0 || off + n > this.src.size) throw new Error('Повреждённый TIFF: ссылка за конец файла');
    return new DataView(await this.src.read(off, n));
  }

  async ifds(): Promise<Ifd[]> {
    const h = await this.dv(0, 8);
    const bo = h.getUint16(0, true);
    if (bo === 0x4949) this.le = true; else if (bo === 0x4d4d) this.le = false; else throw new Error('Это не TIFF');
    const ver = h.getUint16(2, this.le);
    if (ver === 43) throw new Error('BigTIFF не поддерживается — сохраните обычный GeoTIFF (до 4 ГБ) или вырежьте район');
    if (ver !== 42) throw new Error('Это не TIFF');
    const out: Ifd[] = [];
    let off = h.getUint32(4, this.le);
    const seen = new Set<number>();
    while (off && out.length < 32 && !seen.has(off)) {
      seen.add(off);
      const n = (await this.dv(off, 2)).getUint16(0, this.le);
      const d = await this.dv(off + 2, n * 12 + 4);
      const tags = new Map<number, number[] | string>();
      for (let i = 0; i < n; i++) {
        const e = i * 12, tag = d.getUint16(e, this.le), type = d.getUint16(e + 2, this.le), count = d.getUint32(e + 4, this.le);
        const sz = TYPE_SIZE[type];
        if (!sz || count > 1e7) continue;
        const bytes = sz * count;
        const vd = bytes <= 4 ? new DataView(d.buffer, d.byteOffset + e + 8, 4) : await this.dv(d.getUint32(e + 8, this.le), bytes);
        tags.set(tag, this.values(vd, type, count));
      }
      out.push({ tags });
      off = d.getUint32(n * 12, this.le);
    }
    return out;
  }

  private values(v: DataView, type: number, count: number): number[] | string {
    if (type === 2) { let s = ''; for (let i = 0; i < count; i++) { const c = v.getUint8(i); if (c) s += String.fromCharCode(c); } return s; }
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = i * TYPE_SIZE[type];
      switch (type) {
        case 1: case 7: out.push(v.getUint8(o)); break;
        case 6: out.push(v.getInt8(o)); break;
        case 3: out.push(v.getUint16(o, this.le)); break;
        case 8: out.push(v.getInt16(o, this.le)); break;
        case 4: out.push(v.getUint32(o, this.le)); break;
        case 9: out.push(v.getInt32(o, this.le)); break;
        case 5: out.push(v.getUint32(o, this.le) / (v.getUint32(o + 4, this.le) || 1)); break;
        case 10: out.push(v.getInt32(o, this.le) / (v.getInt32(o + 4, this.le) || 1)); break;
        case 11: out.push(v.getFloat32(o, this.le)); break;
        case 12: out.push(v.getFloat64(o, this.le)); break;
      }
    }
    return out;
  }
}

const num = (ifd: Ifd, tag: number, d?: number): number => { const v = ifd.tags.get(tag); return Array.isArray(v) && v.length ? v[0] : (d ?? NaN); };
const arr = (ifd: Ifd, tag: number): number[] => { const v = ifd.tags.get(tag); return Array.isArray(v) ? v : []; };

// ---------- Геопривязка ----------
/** Ключи GeoKeyDirectory: номер ключа → значение (числовое). */
function geoKeys(ifd: Ifd): Map<number, number> {
  const d = arr(ifd, 34735), out = new Map<number, number>();
  for (let i = 4; i + 3 < d.length; i += 4) if (d[i + 1] === 0) out.set(d[i], d[i + 3]);
  return out;
}

/** Система координат растра по ключам; неподдерживаемая — Error с подсказкой. */
export function crsOf(keys: Map<number, number>): Crs {
  const model = keys.get(1024), geo = keys.get(2048), proj = keys.get(3072);
  if (model === 2 || (!proj && geo)) {
    // Датум важен: широта/долгота СК-42 отличается от WGS-84 на 100–150 м. ETRS89 и NAD83 совпадают с WGS-84 до 1–2 м.
    if (geo === 4284) {
      return {
        name: 'СК-42, широта/долгота (EPSG:4284)', geographic: true,
        fwd: (la, lo) => { const g = wgsToSk42Geo(la, lo); return [g.lon, g.lat]; },
        inv: (x, y) => { const g = sk42GeoToWgs(y, x); return [g.lat, g.lon]; },
      };
    }
    if (geo && !WGS_LIKE.includes(geo)) throw new Error(`Широта/долгота на датуме EPSG:${geo} не поддерживается — перепроецируйте в WGS-84: gdalwarp -t_srs EPSG:4326`);
    return { name: geo === 4326 || !geo ? 'WGS-84, широта/долгота' : `EPSG:${geo}, широта/долгота`, geographic: true, fwd: (la, lo) => [lo, la], inv: (x, y) => [y, x] };
  }
  if (proj === 3857 || proj === 900913 || proj === 3785) {
    return {
      name: 'Web Mercator (EPSG:3857)', geographic: false,
      fwd: (la, lo) => [(lo * Math.PI * R_MERC) / 180, R_MERC * Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360))],
      inv: (x, y) => [(Math.atan(Math.sinh(y / R_MERC)) * 180) / Math.PI, (x / R_MERC) * (180 / Math.PI)],
    };
  }
  if (proj && proj >= 32601 && proj <= 32760 && proj % 100 >= 1 && proj % 100 <= 60) {
    const zone = proj % 100, south = proj >= 32701;
    const fwd = (la: number, lo: number): [number, number] => { const u = toUTM(la, lo, zone, south); return [u.e, u.n]; };
    // Обратный — Ньютоном по прямому от центра зоны (1° широты ≈ 110,6 км).
    return { name: `UTM ${zone}${south ? 'S' : 'N'} (EPSG:${proj})`, geographic: false, fwd, inv: (x, y) => newton(fwd, x, y, (south ? y - 1e7 : y) / 110574, zone * 6 - 183) };
  }
  if (proj && proj >= 28404 && proj <= 28432) {
    const zone = proj - 28400;
    return {
      name: `СК-42, зона ${zone} (EPSG:${proj})`, geographic: false,
      fwd: (la, lo) => { const g = toSK42InZone(la, lo, zone); return [g.y, g.x]; },
      inv: (x, y) => { const p = fromSK42(y, x); return [p.lat, p.lon]; },
    };
  }
  const what = proj ? `EPSG:${proj}` : 'без системы координат';
  throw new Error(`Система координат ${what} не поддерживается. Подходят: WGS-84 (4326), Web Mercator (3857), UTM WGS-84 (326xx/327xx), СК-42 Гаусса–Крюгера (284xx). Перепроецируйте: gdalwarp -t_srs EPSG:4326`);
}

/** Аффинное преобразование «угол пикселя (u, v) → X, Y» и обратное. */
interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }
function affineOf(ifd: Ifd): Affine {
  const mt = arr(ifd, 34264);
  if (mt.length >= 8) return { a: mt[0], b: mt[1], c: mt[3], d: mt[4], e: mt[5], f: mt[7] };
  const sc = arr(ifd, 33550), tp = arr(ifd, 33922);
  if (sc.length < 2 || tp.length < 6) throw new Error('В TIFF нет геопривязки (это не GeoTIFF) — нужен файл с координатами');
  // X = Xt + (u − It)·Sx, Y = Yt − (v − Jt)·Sy
  return { a: sc[0], b: 0, c: tp[3] - tp[0] * sc[0], d: 0, e: -sc[1], f: tp[4] + tp[1] * sc[1] };
}

// ---------- Распаковка ----------
function lzw(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let op = 0, bitPos = 0, width = 9;
  const dict: Uint8Array[] = [];
  const reset = () => { dict.length = 258; for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i); width = 9; };
  reset();
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const by = src[(bitPos + i) >> 3];
      if (by === undefined) return 257;
      v = (v << 1) | ((by >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  let prev: Uint8Array | null = null;
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); prev = null; continue; }
    let entry: Uint8Array;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev && code === dict.length) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; }
    else throw new Error('Повреждённые данные LZW');
    const n = Math.min(entry.length, expected - op);
    out.set(entry.subarray(0, n), op); op += n;
    if (prev) { const ne = new Uint8Array(prev.length + 1); ne.set(prev); ne[prev.length] = entry[0]; dict.push(ne); }
    prev = entry;
    // «Ранняя» смена ширины кода, как в libtiff.
    if (dict.length + 1 >= 1 << width && width < 12) width++;
    if (op >= expected) break;
  }
  return op < expected ? out.subarray(0, op) : out;
}

function packbits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { const c = Math.min(n + 1, expected - o); out.set(src.subarray(i, i + c), o); i += n + 1; o += c; }
    else if (n !== -128) { const c = Math.min(1 - n, expected - o); out.fill(src[i++], o, o + c); o += c; }
  }
  return o < expected ? out.subarray(0, o) : out;
}

function decompress(comp: number, b: Uint8Array, expected: number): Uint8Array {
  switch (comp) {
    case 1: return b;
    case 5: return lzw(b, expected);
    // Выход — в буфер ожидаемого размера: «бомба» из маленького файла не раздует память (лишнее отбрасывается).
    case 8: case 32946: try { return unzlibSync(b, { out: new Uint8Array(expected) }); } catch { return inflateSync(b, { out: new Uint8Array(expected) }); }
    case 32773: return packbits(b, expected);
    default: throw new Error(`Сжатие TIFF №${comp} не поддерживается — пересохраните без сжатия, с LZW или Deflate (gdal_translate -co COMPRESS=DEFLATE)`);
  }
}

// ---------- Чтение растра ----------
interface Layout { w: number; h: number; bw: number; bh: number; offs: number[]; cnts: number[]; tiled: boolean }

/** Наибольший блок (тайл или полоса) в распакованном виде, байт: размеры блока — из файла (недоверенного). */
const MAX_BLOCK_BYTES = 64 * 1024 * 1024;

function layoutOf(ifd: Ifd): Layout {
  const w = num(ifd, 256), h = num(ifd, 257);
  if (!(w > 1 && h > 1)) throw new Error('Повреждённый TIFF: размер растра');
  if (ifd.tags.has(322)) {
    const bw = num(ifd, 322), bh = num(ifd, 323);
    // Тайлы TIFF — кратны 16, на практике 256–1024; больше 4096 — повреждение (или ловушка на память).
    if (!(bw >= 16 && bh >= 16 && bw <= 4096 && bh <= 4096)) throw new Error('Повреждённый TIFF: размер тайла');
    return { w, h, bw, bh, offs: arr(ifd, 324), cnts: arr(ifd, 325), tiled: true };
  }
  const rps = Math.min(Math.max(1, num(ifd, 278, h)), h);
  return { w, h, bw: w, bh: rps, offs: arr(ifd, 273), cnts: arr(ifd, 279), tiled: false };
}

/** Прочитать полосу высот IFD в Int16 (м); пропуски — HGT_VOID. */
async function readRaster(rd: Reader, ifd: Ifd): Promise<Int16Array> {
  const L = layoutOf(ifd);
  const spp = num(ifd, 277, 1), bps = num(ifd, 258, 1), fmt = num(ifd, 339, 1), comp = num(ifd, 259, 1);
  const pred = num(ifd, 317, 1), planar = num(ifd, 284, 1);
  const bytes = bps / 8;
  // Цветная картинка (RGB, палитра, YCbCr) или несколько полос — не высоты: значения цвета 0–255 выдали бы ложный рельеф.
  const photo = num(ifd, 262, 1);
  if (spp !== 1 || photo === 2 || photo === 3 || photo === 6) throw new Error('Это цветная картинка, а не растр высот: нужен GeoTIFF с одной полосой высот (DEM)');
  if (![1, 2, 4, 8].includes(bytes) || (fmt === 3 && bytes < 4)) throw new Error(`Тип отсчётов (${bps} бит) не поддерживается — нужны целые 8–32 бит или числа с плавающей точкой`);
  const nd = parseFloat(String(ifd.tags.get(42113) ?? ''));
  const stride = planar === 2 ? 1 : spp;
  const blocksX = Math.ceil(L.w / L.bw), blocksY = Math.ceil(L.h / L.bh);
  const need = blocksX * blocksY;
  if (L.offs.length < need || L.cnts.length < need) throw new Error('Повреждённый TIFF: нет смещений блоков');
  const out = new Int16Array(L.w * L.h);
  const conv = (v: number) => (!Number.isFinite(v) || v === nd || v < -1000 || v > 9000 ? HGT_VOID : Math.round(v));
  for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) {
    const k = by * blocksX + bx;
    const rowsHere = L.tiled ? L.bh : Math.min(L.bh, L.h - by * L.bh);
    const expected = L.bw * rowsHere * stride * bytes;
    if (expected > MAX_BLOCK_BYTES) throw new Error('Блок TIFF слишком большой — пересохраните тайлами (gdal_translate -co TILED=YES)');
    const blk = await rd.dv(L.offs[k], L.cnts[k]);
    let raw = new Uint8Array(blk.buffer as ArrayBuffer, blk.byteOffset, blk.byteLength);
    raw = decompress(comp, raw, expected);
    // Короткий блок — файл повреждён или обрезан: нули выдали бы «уровень моря» и ложную связь, такой файл не берём.
    if (raw.length < expected) throw new Error('Повреждённый TIFF: блок данных короче заявленного — файл обрезан?');
    const rowBytes = L.bw * stride * bytes;
    if (pred === 3) {
      // Предсказатель для плавающей точки: разности байтов по строке, байты разложены по значимости (старшие первыми).
      for (let r = 0; r < rowsHere; r++) {
        const row = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
        for (let i = stride; i < row.length; i++) row[i] = (row[i] + row[i - stride]) & 255;
        const copy = row.slice(), cnt = L.bw * stride;
        for (let i = 0; i < cnt; i++) for (let b = 0; b < bytes; b++) row[i * bytes + b] = copy[(bytes - b - 1) * cnt + i];
      }
    }
    // Предсказатель 3 раскладывает байты в little-endian.
    const le = pred === 3 ? true : rd.le;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const get = (i: number): number => {
      const o = i * bytes;
      if (fmt === 3) return bytes === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
      if (bytes === 1) return fmt === 2 ? dv.getInt8(o) : dv.getUint8(o);
      if (bytes === 2) return fmt === 2 ? dv.getInt16(o, le) : dv.getUint16(o, le);
      return fmt === 2 ? dv.getInt32(o, le) : dv.getUint32(o, le);
    };
    for (let r = 0; r < rowsHere; r++) {
      const y = by * L.bh + r;
      if (y >= L.h) break;
      let acc = 0;
      for (let c = 0; c < L.bw; c++) {
        let v = get((r * L.bw + c) * stride);
        if (pred === 2 && fmt !== 3) {
          // Горизонтальные разности целых — в разрядности отсчёта.
          acc = c === 0 ? v : acc + v;
          v = bytes === 1 ? (fmt === 2 ? (acc << 24) >> 24 : acc & 0xff) : bytes === 2 ? (fmt === 2 ? (acc << 16) >> 16 : acc & 0xffff) : acc | 0;
          acc = v;
        }
        const x = bx * L.bw + c;
        if (x < L.w) out[y * L.w + x] = conv(v);
      }
    }
  }
  return out;
}

/**
 * Открыть GeoTIFF высот: геопривязка, система координат, выбор полного растра или уменьшенной копии (≤ maxPx),
 * чтение и заполнение пропусков. Бросает Error с понятным текстом.
 */
export async function readGeoTiff(src: ByteSource, maxPx = MAX_PX): Promise<TifGrid> {
  if (src.size > TIF_MAX_BYTES) throw new Error('Файл больше 1 ГБ — вырежьте нужный район (gdal_translate -projwin)');
  const rd = new Reader(src);
  const ifds = await rd.ifds();
  if (!ifds.length) throw new Error('Повреждённый TIFF: нет изображений');
  const full = ifds[0];
  const crs = crsOf(geoKeys(full));
  const A = affineOf(full);
  const isPoint = geoKeys(full).get(1025) === 2;
  const W0 = num(full, 256), H0 = num(full, 257);
  // Полный растр или самая подробная уменьшенная копия, что помещается (обзоры COG: NewSubfileType бит 0, без маски).
  const cands = ifds.filter((d, i) => i === 0 || ((num(d, 254, 0) & 1) && !(num(d, 254, 0) & 4)));
  const pick = cands.filter((d) => num(d, 256) * num(d, 257) <= maxPx).sort((a, b) => num(b, 256) - num(a, 256))[0];
  if (!pick) throw new Error(`Растр ${W0}×${H0} — слишком большой (больше ${Math.round(maxPx / 1e6)} Мп) и без уменьшенных копий. Уменьшите: gdal_translate -outsize 50% 50% или сохраните как COG`);
  const data = await readRaster(rd, pick);
  const w = num(pick, 256), h = num(pick, 257);
  let voids = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === HGT_VOID) voids++;
  if (voids === data.length) throw new Error('В растре нет высот (одни пропуски)');
  if (voids) fillVoids(data, w, h);
  const sx = W0 / w, sy = H0 / h;
  // Обратное аффинное: X, Y → угол пикселя полного растра (u, v).
  const det = A.a * A.e - A.b * A.d;
  if (!det) throw new Error('Повреждённая геопривязка');
  const toUV = (X: number, Y: number): [number, number] => {
    const dx = X - A.c, dy = Y - A.f;
    return [(A.e * dx - A.b * dy) / det, (-A.d * dx + A.a * dy) / det];
  };
  const pix = (lat: number, lon: number): [number, number] | null => {
    const [X, Y] = crs.fwd(lat, lon);
    let [u, v] = toUV(X, Y);
    if (isPoint) { u += 0.5; v += 0.5; } // PixelIsPoint: координаты — центров пикселей
    const px = u / sx - 0.5, py = v / sy - 0.5;
    return px >= -0.5 && py >= -0.5 && px <= w - 0.5 && py <= h - 0.5 ? [px, py] : null;
  };
  const height = (lat: number, lon: number): number | null => {
    const p = pix(lat, lon);
    if (!p) return null;
    const x = Math.min(Math.max(p[0], 0), w - 1), y = Math.min(Math.max(p[1], 0), h - 1);
    const x0 = Math.min(x | 0, w - 2), y0 = Math.min(y | 0, h - 2), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
  };
  const bounds = boundsOf(crs, A, W0, H0, isPoint);
  const midLat = (bounds[1] + bounds[3]) / 2;
  const stepM = crs.geographic ? Math.abs(A.a) * sx * 111320 * Math.cos((midLat * Math.PI) / 180) : Math.hypot(A.a, A.d) * sx;
  return { w, h, data, bounds, crs: crs.name, pix, height, stepM, reduced: pick !== full };
}

/** Границы в градусах по углам и серединам сторон растра. */
function boundsOf(crs: Crs, A: Affine, W: number, H: number, isPoint: boolean): [number, number, number, number] {
  const off = isPoint ? -0.5 : 0;
  const pts: [number, number][] = [];
  for (const [u, v] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, 0], [W / 2, H], [0, H / 2], [W, H / 2]]) {
    const X = A.a * (u + off) + A.b * (v + off) + A.c, Y = A.d * (u + off) + A.e * (v + off) + A.f;
    pts.push(crs.inv(X, Y));
  }
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  const b: [number, number, number, number] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  if (!b.every(Number.isFinite) || b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90 || b[0] >= b[2] || b[1] >= b[3]) {
    throw new Error('Геопривязка растра вне Земли — проверьте систему координат файла');
  }
  return b;
}

/** Обратный пересчёт X, Y → [широта, долгота] методом Ньютона по прямому fwd (сходится за 3–5 шагов). */
function newton(fwd: Crs['fwd'], X: number, Y: number, lat: number, lon: number): [number, number] {
  lat = Math.max(-84, Math.min(84, lat));
  for (let i = 0; i < 30; i++) {
    const [x0, y0] = fwd(lat, lon), h = 1e-5;
    const [x1, y1] = fwd(lat + h, lon), [x2, y2] = fwd(lat, lon + h);
    const j11 = (x1 - x0) / h, j21 = (y1 - y0) / h, j12 = (x2 - x0) / h, j22 = (y2 - y0) / h;
    const det = j11 * j22 - j12 * j21;
    if (!det) break;
    const ex = X - x0, ey = Y - y0;
    const dlat = (j22 * ex - j12 * ey) / det, dlon = (-j21 * ex + j11 * ey) / det;
    lat += dlat; lon += dlon;
    if (Math.abs(dlat) + Math.abs(dlon) < 1e-10) break;
  }
  return [lat, lon];
}

// ---------- Тайл высот для расчётов ----------
const TILE = 256;

/**
 * Высоты тайла 256×256 (центры пикселей, как synthTile у HGT) из растра; null — растр покрывает тайл не целиком
 * (тогда тайл берётся из сети). Сначала проверяются углы и середины сторон — чужие тайлы отсекаются сразу.
 */
export function synthFromGrid(z: number, x: number, y: number, g: TifGrid): Float32Array | null {
  const N = 2 ** z;
  const lonOf = (c: number) => ((x * TILE + c + 0.5) / (TILE * N)) * 360 - 180;
  const latOf = (r: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * TILE + r + 0.5)) / (TILE * N)))) * 180) / Math.PI;
  for (const [r, c] of [[0, 0], [0, TILE - 1], [TILE - 1, 0], [TILE - 1, TILE - 1], [0, TILE / 2], [TILE - 1, TILE / 2], [TILE / 2, 0], [TILE / 2, TILE - 1]]) {
    if (!g.pix(latOf(r), lonOf(c))) return null;
  }
  const out = new Float32Array(TILE * TILE);
  const lons = new Float64Array(TILE);
  for (let c = 0; c < TILE; c++) lons[c] = lonOf(c);
  for (let r = 0; r < TILE; r++) {
    const lat = latOf(r);
    for (let c = 0; c < TILE; c++) {
      const v = g.height(lat, lons[c]);
      if (v === null) return null;
      out[r * TILE + c] = v;
    }
  }
  return out;
}
