// Тайлы рельефа: адрес и подсчёт. Чистые функции — их используют страница, Service Worker и тесты.
//
// Источник — Mapterhorn (Terrarium, WebP 512 px, HTTP/2; Copernicus GLO-30 и национальные модели). Расчёты живут в
// «виртуальной» сетке тайлов 256 px (как раньше с AWS): тайл источника 512 px уровня z — это четыре виртуальных
// тайла уровня z + 1 с той же детальностью. Так профиль, зона и мозаика не зависят от размера тайла источника.
import { lonLatToPixel, type LatLon } from './geo';

export const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
/** Начало адреса тайла (до {z}) — по нему Service Worker узнаёт запросы рельефа. */
export const DEM_PREFIX = DEM_URL.slice(0, DEM_URL.indexOf('{z}'));
/** Сторона тайла источника, px. */
export const SRC_TILE = 512;
/** Детальнее z12 источник по всему миру не даёт (z13+ — только в части стран). */
export const SRC_MAX_Z = 12;
/** Сторона виртуального тайла расчётов, px. */
export const TILE = 256;
/** Виртуальный уровень, соответствующий SRC_MAX_Z: пиксель ≈ 19 м на 45° (SRTM/Copernicus 30 м). */
export const DEM_MAX_Z = SRC_MAX_Z + 1;
/** Общий источник тайлов (demSource.ts, maplibre-contour) работает в координатах источника — до SRC_MAX_Z. */
export const SHARED_DEM_MAX_Z = SRC_MAX_Z;
/** Метка источника у офлайн-районов: район со старой меткой (AWS) нужно перекачать. */
export const DEM_SRC_ID = 'mapterhorn';
export const DEM_ATTRIBUTION = '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Рельеф © Mapterhorn</a>';

/** Адрес тайла источника (координаты источника). */
export const demTileUrl = (z: number, x: number, y: number) =>
  DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Тайл источника, содержащий виртуальный тайл (z, x, y), и четверть в нём (qx, qy ∈ {0, 1}). */
export function srcOf(z: number, x: number, y: number): { z: number; x: number; y: number; qx: number; qy: number } {
  return { z: z - 1, x: x >> 1, y: y >> 1, qx: x & 1, qy: y & 1 };
}

/** Диапазон виртуальных тайлов уровня z, накрывающий точки с запасом pad пикселей (X не обёрнут). */
export function demTileSpan(points: LatLon[], z: number, pad = 0): { tx0: number; tx1: number; ty0: number; ty1: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const [x, y] = lonLatToPixel(p.lon, p.lat, z);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return {
    tx0: Math.floor((minX - pad) / TILE), tx1: Math.floor((maxX + pad) / TILE),
    ty0: Math.floor((minY - pad) / TILE), ty1: Math.floor((maxY + pad) / TILE),
  };
}

/** Число виртуальных тайлов уровня z под точками (с запасом pad пикселей). */
export function demTileCount(points: LatLon[], z: number, pad = 0): number {
  const s = demTileSpan(points, z, pad);
  return (s.tx1 - s.tx0 + 1) * (s.ty1 - s.ty0 + 1);
}
