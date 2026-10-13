// Геодезические помощники на сфере (для расстояний до сотен км точности хватает с запасом).
/** Средний радиус Земли, м. */
export const R_EARTH = 6371008.8;
/** Градусы → радианы и обратно. */
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export interface LatLon { lat: number; lon: number }

export function distance(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: LatLon, b: LatLon): number {
  const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(a: LatLon, brgDeg: number, dist: number): LatLon {
  const d = dist / R_EARTH, t = brgDeg * D2R, f1 = a.lat * D2R, l1 = a.lon * D2R;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: f2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

/** Точка на доле t (0..1) дуги большого круга. */
export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  const f1 = a.lat * D2R, l1 = a.lon * D2R, f2 = b.lat * D2R, l2 = b.lon * D2R;
  const d = distance(a, b) / R_EARTH;
  if (d < 1e-12) return { ...a };
  const A = Math.sin((1 - t) * d) / Math.sin(d), B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
  const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
  const z = A * Math.sin(f1) + B * Math.sin(f2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) * R2D, lon: Math.atan2(y, x) * R2D };
}

/** Глобальные пиксельные координаты Web Mercator на уровне z (тайл 256). */
export function lonLatToPixel(lon: number, lat: number, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const s = Math.sin(lat * D2R);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function pixelToLonLat(px: number, py: number, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * R2D;
  return [lon, lat];
}
