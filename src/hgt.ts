// Свой рельеф из файлов SRTM HGT (big-endian int16, квадрат 1°×1°, привязка — по имени файла).
// Чистая логика без DOM: разбор, высота в точке, покрытие тайла Terrarium и синтез тайла высот.

const HGT_MAX_BYTES = 30 * 1024 * 1024;
export const HGT_VOID = -32768;
/** Допустимые стороны сетки: SRTM3 (3″) и SRTM1 (1″). */
const SIDES = [1201, 3601] as const;
/** Тайл, которому нужно больше ячеек, не синтезируем (низкие зумы — берём сеть). */
const MAX_CELLS = 9;

/** Юго-западный угол по имени вида N55E037.hgt (регистр не важен); иначе null. */
export function parseHgtName(name: string): { lat: number; lon: number } | null {
  const m = /^([NS])(\d{2})([EW])(\d{3})\.hgt$/i.exec(name);
  if (!m) return null;
  const la = +m[2], lo = +m[4];
  const lat = m[1].toUpperCase() === 'N' ? la : -la;
  const lon = m[3].toUpperCase() === 'E' ? lo : -lo;
  if (lat < -90 || lat > 89 || lon < -180 || lon > 179) return null;
  return { lat, lon };
}

/** Сторона сетки по размеру файла (ровно N²·2 байт) или null. */
export function hgtSideFromSize(bytes: number): number | null {
  return SIDES.find((n) => n * n * 2 === bytes) ?? null;
}

/** Проверка до чтения содержимого: имя и размер. Возвращает текст ошибки или null. */
export function checkHgtFile(name: string, size: number): string | null {
  if (!parseHgtName(name)) return 'Имя файла должно быть вида N55E037.hgt (юго-западный угол ячейки)';
  if (size > HGT_MAX_BYTES) return 'Файл больше 30 МБ — это не HGT-ячейка';
  if (!hgtSideFromSize(size)) return 'Размер файла не 1201×1201 и не 3601×3601 отсчётов (int16) — поддерживаются только SRTM 3″ и 1″';
  return null;
}

export class HgtTile {
  /** voids — сколько пропусков заполнено при разборе. */
  constructor(public lat0: number, public lon0: number, public n: number, public data: Int16Array, public voids = 0) {}

  /** Разбор буфера HGT; бросает Error с понятным текстом. */
  static fromBuffer(name: string, buf: ArrayBuffer): HgtTile {
    const err = checkHgtFile(name, buf.byteLength);
    if (err) throw new Error(err);
    const sw = parseHgtName(name)!;
    const n = hgtSideFromSize(buf.byteLength)!;
    const dv = new DataView(buf);
    const data = new Int16Array(n * n);
    let voids = 0;
    for (let i = 0; i < data.length; i++) {
      const v = dv.getInt16(i * 2, false);
      if (v === HGT_VOID) voids++;
      data[i] = v;
    }
    if (voids === data.length) throw new Error('Ячейка целиком без данных');
    if (voids) fillVoids(data, n);
    return new HgtTile(sw.lat, sw.lon, n, data, voids);
  }

  /** Билинейная высота, м; координаты за пределами ячейки зажимаются к краю. */
  height(lat: number, lon: number): number {
    const m = this.n - 1;
    const u = Math.min(Math.max((lon - this.lon0) * m, 0), m);
    const v = Math.min(Math.max((this.lat0 + 1 - lat) * m, 0), m);
    const x0 = Math.min(u | 0, m - 1), y0 = Math.min(v | 0, m - 1);
    const fx = u - x0, fy = v - y0, d = this.data, n = this.n, i = y0 * n + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + n] * (1 - fx) + d[i + n + 1] * fx) * fy;
  }
}

/** Заполнение пропусков: линейно по строке между ближайшими валидными, иначе по столбцу. */
function fillVoids(d: Int16Array, n: number) {
  const run = (start: number, step: number, len: number) => {
    let last = -1;
    for (let k = 0; k <= len; k++) {
      if (k < len && d[start + k * step] === HGT_VOID) continue;
      if (k - last > 1) {
        const a = last >= 0 ? d[start + last * step] : null, b = k < len ? d[start + k * step] : null;
        if (a !== null || b !== null) {
          for (let j = last + 1; j < k; j++) {
            d[start + j * step] = a === null ? b! : b === null ? a : Math.round(a + ((b - a) * (j - last)) / (k - last));
          }
        }
      }
      last = k;
    }
  };
  for (let r = 0; r < n; r++) run(r * n, 1, n);
  for (let c = 0; c < n; c++) run(c, n, n);
}

// ---------- Тайлы Terrarium ----------
const TILE = 256;

/** Границы тайла XYZ в градусах. */
export function tileBounds(z: number, x: number, y: number) {
  const N = 2 ** z;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / N))) * 180) / Math.PI;
  return { north: lat(y), south: lat(y + 1), west: (x / N) * 360 - 180, east: ((x + 1) / N) * 360 - 180 };
}

/** Ячейки (юго-западные углы), которые нужны тайлу; null — слишком много/вне допустимого диапазона. */
export function cellsForTile(z: number, x: number, y: number): [number, number][] | null {
  const b = tileBounds(z, x, y);
  const la0 = Math.floor(b.south), la1 = Math.ceil(b.north) - 1, lo0 = Math.floor(b.west), lo1 = Math.ceil(b.east) - 1;
  if (!(la1 >= la0 && lo1 >= lo0) || (la1 - la0 + 1) * (lo1 - lo0 + 1) > MAX_CELLS) return null;
  const out: [number, number][] = [];
  for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) out.push([la, lo]);
  return out;
}

/** Покрывают ли имеющиеся ячейки весь тайл; возвращает их список или null. */
export function tileCoverage(z: number, x: number, y: number, has: (lat: number, lon: number) => boolean): [number, number][] | null {
  const cells = cellsForTile(z, x, y);
  return cells && cells.every(([la, lo]) => has(la, lo)) ? cells : null;
}

/** Высоты тайла 256×256 (центры пикселей); null, если какой-то ячейки нет. */
export function synthTile(z: number, x: number, y: number, get: (lat: number, lon: number) => HgtTile | undefined): Float32Array | null {
  const N = 2 ** z;
  const out = new Float32Array(TILE * TILE);
  const lons = new Float64Array(TILE);
  for (let c = 0; c < TILE; c++) lons[c] = ((x * TILE + c + 0.5) / (TILE * N)) * 360 - 180;
  for (let r = 0; r < TILE; r++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * TILE + r + 0.5)) / (TILE * N)))) * 180) / Math.PI;
    const la = Math.floor(lat);
    for (let c = 0; c < TILE; c++) {
      const t = get(la, Math.floor(lons[c]));
      if (!t) return null;
      out[r * TILE + c] = t.height(lat, lons[c]);
    }
  }
  return out;
}
