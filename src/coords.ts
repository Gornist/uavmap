// Форматы координат. СК-42 — прямоугольные координаты Гаусса–Крюгера (как на советских/российских топокартах),
// параметры перехода WGS-84 → СК-42 по ГОСТ 32453-2017 (7 параметров, эллипсоид Красовского).
// Пересчёт свой, без библиотек: геодезические ↔ геоцентрические, Гельмерт (7 параметров, малые углы),
// поперечная проекция Меркатора рядами Крюгера по n до n⁶ (Karney 2011, J. Geodesy 85:475) — ошибка
// < 0.1 мм в пределах ±3° от осевого меридиана. Соглашение знаков поворотов — как у +towgs84 в PROJ/proj4
// (position vector, параметры СК-42 → WGS-84), результат совпадает с прежней реализацией на proj4.

export type CoordFormat = 'sk42' | 'dd' | 'dms';

interface Ellipsoid { a: number; es: number }
const ell = (a: number, rf: number): Ellipsoid => { const f = 1 / rf; return { a, es: f * (2 - f) }; };
const WGS84 = ell(6378137, 298.257223563);
const KRASS = ell(6378245, 298.3);

const SEC = Math.PI / (180 * 3600);
/** ГОСТ 32453-2017, СК-42 → WGS-84: dX, dY, dZ (м), ωx, ωy, ωz (″), m (ppm). */
const SK42_TOWGS = [23.57, -140.95, -79.8, 0, 0.35, 0.79, -0.22] as const;
const [DX, DY, DZ] = SK42_TOWGS;
const RX = SK42_TOWGS[3] * SEC, RY = SK42_TOWGS[4] * SEC, RZ = SK42_TOWGS[5] * SEC, M = 1 + SK42_TOWGS[6] * 1e-6;

type Vec3 = [number, number, number];
const D2R = Math.PI / 180;

function toGeocentric(latDeg: number, lonDeg: number, e: Ellipsoid): Vec3 {
  const p = latDeg * D2R, l = lonDeg * D2R, s = Math.sin(p), c = Math.cos(p);
  const n = e.a / Math.sqrt(1 - e.es * s * s);
  return [n * c * Math.cos(l), n * c * Math.sin(l), n * (1 - e.es) * s];
}

/** Геоцентрические → геодезические (итерация по широте, высота отбрасывается). */
function fromGeocentric([x, y, z]: Vec3, e: Ellipsoid): { lat: number; lon: number } {
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e.es));
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(phi), n = e.a / Math.sqrt(1 - e.es * s * s);
    const next = Math.atan2(z + e.es * n * s, p);
    const done = Math.abs(next - phi) < 1e-14;
    phi = next;
    if (done) break;
  }
  return { lat: phi / D2R, lon: Math.atan2(y, x) / D2R };
}

/** СК-42 → WGS-84 (геоцентрические), Гельмерт position vector, малые углы. */
function sk42ToWgs([x, y, z]: Vec3): Vec3 {
  return [
    M * (x - RZ * y + RY * z) + DX,
    M * (RZ * x + y - RX * z) + DY,
    M * (-RY * x + RX * y + z) + DZ,
  ];
}

/** WGS-84 → СК-42: обратное преобразование (транспонированная матрица поворота, как в PROJ/proj4). */
function wgsToSk42([x, y, z]: Vec3): Vec3 {
  const u = (x - DX) / M, v = (y - DY) / M, w = (z - DZ) / M;
  return [u + RZ * v - RY * w, -RZ * u + v + RX * w, RY * u - RX * v + w];
}

// Поперечная проекция Меркатора на эллипсоиде Красовского, ряды Крюгера (Karney 2011, порядок n⁶).
const N = (1 - Math.sqrt(1 - KRASS.es)) / (1 + Math.sqrt(1 - KRASS.es)); // n = f/(2−f)
const N2 = N * N, N3 = N2 * N, N4 = N3 * N, N5 = N4 * N, N6 = N5 * N;
const E = Math.sqrt(KRASS.es);
/** Радиус спрямляющей сферы A (k = 1). */
const A = (KRASS.a / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
/** Коэффициенты α прямого ряда Крюгера по n = f/(2−f). */
function alphaOf(n: number): number[] {
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  return [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400,
  ];
}
const ALPHA = alphaOf(N);
const BETA = [
  N / 2 - (2 * N2) / 3 + (37 * N3) / 96 - N4 / 360 - (81 * N5) / 512 + (96199 * N6) / 604800,
  N2 / 48 + N3 / 15 - (437 * N4) / 1440 + (46 * N5) / 105 - (1118711 * N6) / 3870720,
  (17 * N3) / 480 - (37 * N4) / 840 - (209 * N5) / 4480 + (5569 * N6) / 90720,
  (4397 * N4) / 161280 - (11 * N5) / 504 - (830251 * N6) / 7257600,
  (4583 * N5) / 161280 - (108847 * N6) / 3991680,
  (20648693 * N6) / 638668800,
];

/** τ' = tg конформной широты по τ = tg геодезической. */
function tauPrime(tau: number): number {
  const s = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
  return tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
}

const zoneMeridian = (zone: number) => zone * 6 - 3;
const zoneFalseEasting = (zone: number) => zone * 1e6 + 500000;

/** Прямая проекция: геодезические (Красовский) → x (север), y (восток с номером зоны). */
function gkForward(latDeg: number, lonDeg: number, zone: number): { x: number; y: number } {
  const l = (lonDeg - zoneMeridian(zone)) * D2R;
  const tp = tauPrime(Math.tan(latDeg * D2R)), cl = Math.cos(l);
  const xi0 = Math.atan2(tp, cl), eta0 = Math.asinh(Math.sin(l) / Math.hypot(tp, cl));
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  return { x: A * xi, y: A * eta + zoneFalseEasting(zone) };
}

/** Обратная проекция: x, y зоны → геодезические (Красовский), градусы. */
function gkInverse(x: number, y: number, zone: number): { lat: number; lon: number } {
  const xi = x / A, eta = (y - zoneFalseEasting(zone)) / A;
  let xi0 = xi, eta0 = eta;
  for (let j = 1; j <= 6; j++) {
    xi0 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta0 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const se = Math.sinh(eta0), cx = Math.cos(xi0);
  const tp = Math.sin(xi0) / Math.hypot(se, cx);
  // τ по τ' — метод Ньютона (Karney 2011, ур. 19–20).
  let tau = tp;
  for (let i = 0; i < 10; i++) {
    const t1 = tauPrime(tau), s1 = Math.sqrt(1 + t1 * t1), st = Math.sqrt(1 + tau * tau);
    const d = ((tp - t1) / s1) * ((1 + (1 - KRASS.es) * tau * tau) / ((1 - KRASS.es) * st));
    tau += d;
    if (Math.abs(d) < 1e-13 * Math.max(1, Math.abs(tau))) break;
  }
  return { lat: Math.atan(tau) / D2R, lon: zoneMeridian(zone) + Math.atan2(se, cx) / D2R };
}

/** WGS-84 → СК-42 без округления (м); зона = ⌊λ/6⌋+1. */
export function toSK42Exact(lat: number, lon: number): { x: number; y: number; zone: number } {
  const zone = Math.floor(lon / 6) + 1;
  const g = fromGeocentric(wgsToSk42(toGeocentric(lat, lon, WGS84)), KRASS);
  return { ...gkForward(g.lat, g.lon, zone), zone };
}

/** WGS-84 → СК-42, X/Y округлены до метра (как на карте). */
export function toSK42(lat: number, lon: number): { x: number; y: number; zone: number } {
  const { x, y, zone } = toSK42Exact(lat, lon);
  return { x: Math.round(x), y: Math.round(y), zone };
}

export function fromSK42(x: number, y: number): { lat: number; lon: number } {
  const zone = Math.floor(y / 1e6);
  const g = gkInverse(x, y, zone);
  return fromGeocentric(sk42ToWgs(toGeocentric(g.lat, g.lon, KRASS)), WGS84);
}

/**
 * WGS-84 → СК-42 в заданной зоне Гаусса–Крюгера, м (x — север, y — восток с номером зоны, как в EPSG:284xx).
 * Для своего рельефа в СК-42: точку переводим в зону растра, даже если она за краем зоны.
 */
export function toSK42InZone(lat: number, lon: number, zone: number): { x: number; y: number } {
  const g = fromGeocentric(wgsToSk42(toGeocentric(lat, lon, WGS84)), KRASS);
  return gkForward(g.lat, g.lon, zone);
}

/** WGS-84 → геодезические СК-42 (Красовский), градусы: для растров в широте/долготе СК-42 (EPSG:4284). */
export function wgsToSk42Geo(lat: number, lon: number): { lat: number; lon: number } {
  return fromGeocentric(wgsToSk42(toGeocentric(lat, lon, WGS84)), KRASS);
}

/** Геодезические СК-42 → WGS-84, градусы. */
export function sk42GeoToWgs(lat: number, lon: number): { lat: number; lon: number } {
  return fromGeocentric(sk42ToWgs(toGeocentric(lat, lon, KRASS)), WGS84);
}

// UTM на WGS-84: та же поперечная Меркатора рядами Крюгера, k0 = 0,9996, ложный восток 500 км, на юге — север 10 000 км.
const UN = (1 - Math.sqrt(1 - WGS84.es)) / (1 + Math.sqrt(1 - WGS84.es));
const UE = Math.sqrt(WGS84.es);
const UA = 0.9996 * (WGS84.a / (1 + UN)) * (1 + UN ** 2 / 4 + UN ** 4 / 64 + UN ** 6 / 256);
const UALPHA = alphaOf(UN);

/** WGS-84 → UTM зоны zone (северное или южное полушарие), м. */
export function toUTM(lat: number, lon: number, zone: number, south: boolean): { e: number; n: number } {
  const l = (lon - (zone * 6 - 183)) * D2R, tau = Math.tan(lat * D2R);
  const sg = Math.sinh(UE * Math.atanh((UE * tau) / Math.sqrt(1 + tau * tau)));
  const tp = tau * Math.sqrt(1 + sg * sg) - sg * Math.sqrt(1 + tau * tau), cl = Math.cos(l);
  const xi0 = Math.atan2(tp, cl), eta0 = Math.asinh(Math.sin(l) / Math.hypot(tp, cl));
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 6; j++) {
    xi += UALPHA[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += UALPHA[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  return { e: UA * eta + 500000, n: UA * xi + (south ? 10000000 : 0) };
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
  const t = text.replace(/,(?=\d)/g, '.');
  // Г°М′С″ с полушариями (в том числе формат, который выводит formatCoords('dms')).
  const dmsRe = /(-?\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEWСЮВЗ])?/gi;
  const dms = [...t.matchAll(dmsRe)];
  if (dms.length >= 2) {
    const val = (m: RegExpMatchArray) => {
      const deg = +m[1], sign = deg < 0 || Object.is(deg, -0) ? -1 : 1;
      const v = Math.abs(deg) + (+(m[2] || 0)) / 60 + (+(m[3] || 0)) / 3600;
      return /[SWЮЗ]/i.test(m[4] || '') ? -v : sign * v;
    };
    const [a, b] = dms;
    const aIsLon = /[EWВЗ]/i.test(a[4] || '');
    const lat = aIsLon ? val(b) : val(a), lon = aIsLon ? val(a) : val(b);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }
  const nums = (t.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (nums.length < 2) return null;
  let [a, b] = nums;
  if (a > 1e5 && b > 1e5) {
    // СК-42: по умолчанию «X Y»; если первой подписана Y — меняем местами.
    if (/^\s*Y/i.test(t) || (/X/i.test(t) && t.search(/Y/i) < t.search(/X/i))) [a, b] = [b, a];
    return fromSK42(a, b);
  }
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  return null;
}
