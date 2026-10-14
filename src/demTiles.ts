// Тайлы рельефа Terrarium (Mapzen/AWS Open Data): адрес и подсчёт. Чистые функции — их используют
// страница, Service Worker и тесты.
import { lonLatToPixel, type LatLon } from './geo';

export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Начало адреса тайла (до {z}) — по нему Service Worker узнаёт запросы рельефа. */
export const DEM_PREFIX = DEM_URL.slice(0, DEM_URL.indexOf('{z}'));
export const DEM_MAX_Z = 15;
/** Детальнее z13 в общем источнике тайлов (demSource.ts) нет — как у офлайн-районов; профили и зона на наших широтах — z ≤ 13. */
export const SHARED_DEM_MAX_Z = 13;
export const TILE = 256;

export const demTileUrl = (z: number, x: number, y: number) =>
  DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Диапазон тайлов уровня z, накрывающий точки с запасом pad пикселей (X не обёрнут). */
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

/** Число тайлов уровня z под точками (с запасом pad пикселей). */
export function demTileCount(points: LatLon[], z: number, pad = 0): number {
  const s = demTileSpan(points, z, pad);
  return (s.tx1 - s.tx0 + 1) * (s.ty1 - s.ty0 + 1);
}
