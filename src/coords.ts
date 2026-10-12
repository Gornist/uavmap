// Форматы координат. СК-42 — прямоугольные координаты Гаусса–Крюгера (как на советских/российских топокартах),
// параметры перехода WGS-84 → СК-42 по ГОСТ 32453-2017 (7 параметров, эллипсоид Красовского).
import proj4 from 'proj4';

export type CoordFormat = 'sk42' | 'dd' | 'dms';

const SK42_TOWGS = '23.57,-140.95,-79.8,0,0.35,0.79,-0.22';

function sk42Def(zone: number) {
  return `+proj=tmerc +lat_0=0 +lon_0=${zone * 6 - 3} +k=1 +x_0=${zone * 1e6 + 500000} +y_0=0 +ellps=krass +towgs84=${SK42_TOWGS} +units=m +no_defs`;
}

export function toSK42(lat: number, lon: number): { x: number; y: number; zone: number } {
  const zone = Math.floor(lon / 6) + 1;
  const [e, n] = proj4('WGS84', sk42Def(zone), [lon, lat]);
  return { x: Math.round(n), y: Math.round(e), zone };
}

export function fromSK42(x: number, y: number): { lat: number; lon: number } {
  const zone = Math.floor(y / 1e6);
  const [lon, lat] = proj4(sk42Def(zone), 'WGS84', [y, x]);
  return { lat, lon };
}

function dms(v: number, pos: string, neg: string) {
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`;
}

/** Подсветка километровых цифр (как на карте: 53<b>20</b>890). */
function kmDigits(v: number): string {
  const s = String(v);
  const k = s.length - 3;
  return `${s.slice(0, k - 2)}<em>${s.slice(k - 2, k)}</em>${s.slice(k)}`;
}

export interface CoordRows { label: string; rows: [string, string][]; short: string }

export function formatCoords(lat: number, lon: number, f: CoordFormat): CoordRows {
  if (f === 'sk42') {
    const { x, y } = toSK42(lat, lon);
    return { label: 'СК-42', rows: [['X', kmDigits(x)], ['Y', kmDigits(y)]], short: `X ${kmDigits(x)} Y ${kmDigits(y)}` };
  }
  if (f === 'dms') {
    const a = dms(lat, 'N', 'S'), b = dms(lon, 'E', 'W');
    return { label: 'WGS-84', rows: [['Ш', a], ['Д', b]], short: `${a} ${b}` };
  }
  return { label: 'WGS-84', rows: [['Ш', lat.toFixed(6)], ['Д', lon.toFixed(6)]], short: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

/** Разбор введённых координат: «55.75 37.62», «55,75; 37,62» или СК-42 «X 6175000 Y 7412000». */
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const nums = (text.replace(/,(?=\d)/g, '.').match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (nums.length < 2) return null;
  const [a, b] = nums;
  if (a > 1e5 && b > 1e5) return fromSK42(a, b);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  return null;
}
