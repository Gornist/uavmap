// Высоты рельефа из открытых тайлов Terrarium (Mapzen/AWS Open Data, SRTM/ASTER/GMTED и др.).
// Значение = R*256 + G + B/256 − 32768 (метры над уровнем моря).
import { LatLon, lonLatToPixel, interpolate } from './geo';

export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAX_Z = 15;
const TILE = 256;

const cache = new Map<string, Promise<Float32Array | null>>();

function decode(img: ImageBitmap): Float32Array {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
  return out;
}

export function getTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)))
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then((b) => createImageBitmap(b))
      .then(decode)
      .catch(() => { cache.delete(key); return null; });
    cache.set(key, p);
    if (cache.size > 600) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Часть тайлов рельефа не загрузилась: считать по нулям нельзя — вердикт был бы ложным. */
export class DemMissingError extends Error {
  constructor(public tiles: number) {
    super(`Нет данных рельефа (${tiles} тайл.) — проверьте интернет или офлайн-карты`);
    this.name = 'DemMissingError';
  }
}

/** Мозаика высот, склеенная из тайлов: удобно передавать в воркер одним массивом. */
export interface DemGrid {
  z: number; px0: number; py0: number; // левый верхний угол в глобальных пикселях
  width: number; height: number;
  data: Float32Array;
}

export async function fetchGrid(points: LatLon[], z: number, pad = 2): Promise<DemGrid> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const [x, y] = lonLatToPixel(p.lon, p.lat, z);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const tx0 = Math.floor((minX - pad) / TILE), tx1 = Math.floor((maxX + pad) / TILE);
  const ty0 = Math.floor((minY - pad) / TILE), ty1 = Math.floor((maxY + pad) / TILE);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const width = cols * TILE, height = rows * TILE;
  const data = new Float32Array(width * height);
  const jobs: Promise<void>[] = [];
  let missing = 0;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(getTile(z, tx, ty).then((t) => {
      if (!t) { missing++; return; }
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let r = 0; r < TILE; r++) data.set(t.subarray(r * TILE, r * TILE + TILE), (oy + r) * width + ox);
    }));
  }
  await Promise.all(jobs);
  if (missing) throw new DemMissingError(missing);
  return { z, px0: tx0 * TILE, py0: ty0 * TILE, width, height, data };
}

/** Билинейная выборка из мозаики по глобальным пикселям. */
export function sampleGrid(g: DemGrid, gx: number, gy: number): number {
  const x = Math.min(Math.max(gx - g.px0 - 0.5, 0), g.width - 1.001);
  const y = Math.min(Math.max(gy - g.py0 - 0.5, 0), g.height - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = y0 * g.width + x0, d = g.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.width] * (1 - fx) + d[i + g.width + 1] * fx) * fy;
}

/** Высота в точке или null, если рельеф недоступен. */
export async function elevationAt(p: LatLon, z = 14): Promise<number | null> {
  try {
    const g = await fetchGrid([p], z, 1);
    const [x, y] = lonLatToPixel(p.lon, p.lat, z);
    return sampleGrid(g, x, y);
  } catch (e) {
    if (e instanceof DemMissingError) return null;
    throw e;
  }
}

/** Уровень DEM, при котором шаг пикселя ≈ требуемому шагу выборки. */
export function zoomForStep(lat: number, stepM: number): number {
  const mPerPxZ0 = (40075016.7 * Math.cos((lat * Math.PI) / 180)) / TILE;
  return Math.max(8, Math.min(DEM_MAX_Z, Math.round(Math.log2(mPerPxZ0 / stepM))));
}

/** Профиль рельефа между двумя точками: n+1 отметок по дуге большого круга. */
export async function profile(a: LatLon, b: LatLon, n: number, z: number): Promise<Float32Array> {
  // Грузим только тайлы, через которые проходит трасса.
  const pix: [number, number][] = [];
  const need = new Map<string, [number, number]>();
  for (let i = 0; i <= n; i++) {
    const p = interpolate(a, b, i / n);
    const [x, y] = lonLatToPixel(p.lon, p.lat, z);
    pix.push([x - 0.5, y - 0.5]);
    for (const dx of [0, 1]) for (const dy of [0, 1]) {
      const tx = Math.floor((x - 0.5 + dx) / TILE), ty = Math.floor((y - 0.5 + dy) / TILE);
      need.set(`${tx}/${ty}`, [tx, ty]);
    }
  }
  const tiles = new Map<string, Float32Array>();
  let missing = 0;
  await Promise.all([...need].map(([k, [tx, ty]]) => getTile(z, tx, ty).then((t) => { if (t) tiles.set(k, t); else missing++; })));
  if (missing) throw new DemMissingError(missing);
  const at = (ix: number, iy: number) => {
    const tx = Math.floor(ix / TILE), ty = Math.floor(iy / TILE);
    return tiles.get(`${tx}/${ty}`)![(iy - ty * TILE) * TILE + (ix - tx * TILE)];
  };
  const out = new Float32Array(n + 1);
  pix.forEach(([x, y], i) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    out[i] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  });
  return out;
}
