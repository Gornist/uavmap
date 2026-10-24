import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { formatCoords, fromSK42, parseCoords, toSK42, toSK42Exact, toSK42InZone, toUTM } from './coords';
import { distance } from './geo';

/** Эллипсоид Красовского (a=6378245, 1/f=298.3): длина дуги меридиана от экватора, м (численное интегрирование). */
function meridianArc(latDeg: number): number {
  const a = 6378245, f = 1 / 298.3, e2 = f * (2 - f);
  const phi = (latDeg * Math.PI) / 180, n = 20000;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = ((i + 0.5) / n) * phi;
    s += (a * (1 - e2)) / (1 - e2 * Math.sin(p) ** 2) ** 1.5;
  }
  return (s * phi) / n;
}

describe('toSK42 / fromSK42', () => {
  const pts: [string, number, number][] = [
    ['Москва', 55.7558, 37.6173], ['Сочи', 43.585, 39.72], ['Новосибирск', 55.03, 82.92],
    ['Владивосток', 43.1155, 131.8855], ['Мурманск', 68.97, 33.07], ['Калининград', 54.71, 20.51],
  ];
  it.each(pts)('%s: туда-обратно < 1 м (округление до метра в toSK42 даёт до ≈0.7 м)', (_n, lat, lon) => {
    const s = toSK42(lat, lon);
    const b = fromSK42(s.x, s.y);
    expect(distance({ lat, lon }, b)).toBeLessThan(1);
  });

  it('номер зоны: 37.6° → 7, Y начинается с 7 (зона = ⌊λ/6⌋+1)', () => {
    const s = toSK42(55.7558, 37.6173);
    expect(s.zone).toBe(7);
    expect(String(s.y)[0]).toBe('7');
    expect(String(s.y).length).toBe(7);
  });
  it('другие зоны: Владивосток 131.9° → 22 (Y 22xxxxx), Калининград 20.5° → 4, Новосибирск 82.9° → 14', () => {
    expect(toSK42(43.1155, 131.8855).zone).toBe(22);
    expect(String(toSK42(43.1155, 131.8855).y).startsWith('22')).toBe(true);
    expect(toSK42(54.71, 20.51).zone).toBe(4);
    expect(toSK42(55.03, 82.92).zone).toBe(14);
  });
  it('X для Москвы ≈ 6 18x xxx (северная координата), Y ≈ 7 41x xxx', () => {
    const s = toSK42(55.7558, 37.6173);
    expect(s.x).toBeGreaterThan(6100000);
    expect(s.x).toBeLessThan(6200000);
    expect(s.y).toBeGreaterThan(7400000);
    expect(s.y).toBeLessThan(7430000);
  });
  it('контрольная точка: Кремль 55.7558N 37.6173E ↔ Pulkovo 1942 / GK zone 7 (EPSG:28407), допуск 5 м', () => {
    // Эталон: определение EPSG:28407 (CM 39°E, FE 7 500 000, Красовский) с набором towgs84 EPSG
    // 23.92,−141.27,−80.9,0,0.35,0.82,−0.12 — отличается от ГОСТ 32453-2017, расхождение < 1 м.
    const ref = proj4(
      'WGS84',
      '+proj=tmerc +lat_0=0 +lon_0=39 +k=1 +x_0=7500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,0,0.35,0.82,-0.12 +units=m +no_defs',
      [37.6173, 55.7558],
    );
    const s = toSK42(55.7558, 37.6173);
    expect(Math.hypot(s.y - ref[0], s.x - ref[1])).toBeLessThan(5);
  });
  it('независимая проверка проекции: на осевом меридиане 39° X = длина дуги меридиана Красовского (±100 м за счёт сдвига датума)', () => {
    const s = toSK42(55.75, 39);
    expect(Math.abs(s.x - meridianArc(55.75))).toBeLessThan(100);
    expect(Math.abs(s.y - 7500000)).toBeLessThan(150);
  });
  it('север → X растёт, восток → Y растёт; 1 км ≈ 1 км (масштаб k=1, искажение < 0.1% у осевого)', () => {
    const a = toSK42(55.75, 39), b = toSK42(55.75 + 1 / 111.2, 39), c = toSK42(55.75, 39 + 1 / (111.2 * Math.cos((55.75 * Math.PI) / 180)));
    expect(b.x - a.x).toBeGreaterThan(995);
    expect(b.x - a.x).toBeLessThan(1005);
    expect(c.y - a.y).toBeGreaterThan(995);
    expect(c.y - a.y).toBeLessThan(1005);
  });
  it('fromSK42 по зоне из Y', () => {
    const p = fromSK42(6182341, 7413306);
    expect(p.lat).toBeCloseTo(55.7558, 4);
    expect(p.lon).toBeCloseTo(37.6173, 4);
  });
  it('зона-граница: 35.9999° (зона 6) и 36.0001° (зона 7) — точки рядом на карте', () => {
    const a = toSK42(55, 35.9999), b = toSK42(55, 36.0001);
    expect(a.zone).toBe(6);
    expect(b.zone).toBe(7);
    expect(distance(fromSK42(a.x, a.y), { lat: 55, lon: 35.9999 })).toBeLessThan(1);
    expect(distance(fromSK42(b.x, b.y), { lat: 55, lon: 36.0001 })).toBeLessThan(1);
  });
});

describe('свой пересчёт против proj4 (эталон, devDependency)', () => {
  const TOWGS = '23.57,-140.95,-79.8,0,0.35,0.79,-0.22';
  const def = (zone: number) =>
    `+proj=tmerc +lat_0=0 +lon_0=${zone * 6 - 3} +k=1 +x_0=${zone * 1e6 + 500000} +y_0=0 +ellps=krass +towgs84=${TOWGS} +units=m +no_defs`;
  // Сетка: широты 40–70°, зоны 4–32, по 7 долгот на зону, включая края ±2.9° от осевого меридиана.
  const grid: [number, number, number][] = [];
  for (let zone = 4; zone <= 32; zone++) {
    for (const dl of [-2.9, -2, -1, 0, 1, 2, 2.9]) {
      for (let lat = 40; lat <= 70; lat += 5) grid.push([lat + 0.123, zone * 6 - 3 + dl, zone]);
    }
  }
  it('прямой: X/Y совпадают с proj4 ≤ 1 см (без округления), toSK42 — округлённый эталон', () => {
    let maxDx = 0, maxDy = 0;
    for (const [lat, lon, zone] of grid) {
      const [e, n] = proj4('WGS84', def(zone), [lon, lat]);
      const s = toSK42Exact(lat, lon);
      expect(s.zone).toBe(zone);
      maxDx = Math.max(maxDx, Math.abs(s.x - n));
      maxDy = Math.max(maxDy, Math.abs(s.y - e));
      const r = toSK42(lat, lon);
      expect(Math.abs(r.x - n)).toBeLessThanOrEqual(0.51);
      expect(Math.abs(r.y - e)).toBeLessThanOrEqual(0.51);
    }
    expect(maxDx).toBeLessThanOrEqual(0.01);
    expect(maxDy).toBeLessThanOrEqual(0.01);
  });
  it('обратный: fromSK42 совпадает с proj4 ≤ 1e-7°; туда-обратно < 1 см', () => {
    let maxLat = 0, maxLon = 0, maxRt = 0;
    for (const [lat, lon, zone] of grid) {
      const [e, n] = proj4('WGS84', def(zone), [lon, lat]);
      const [rlon, rlat] = proj4(def(zone), 'WGS84', [e, n]);
      const p = fromSK42(n, e);
      maxLat = Math.max(maxLat, Math.abs(p.lat - rlat));
      maxLon = Math.max(maxLon, Math.abs(p.lon - rlon));
      maxRt = Math.max(maxRt, distance(p, { lat, lon }));
    }
    expect(maxLat).toBeLessThan(1e-7);
    expect(maxLon).toBeLessThan(1e-7);
    expect(maxRt).toBeLessThan(0.01);
  });
});

describe('formatCoords', () => {
  it('dd: 6 знаков в rows, 5 в short', () => {
    const c = formatCoords(55.7558, 37.6173, 'dd');
    expect(c.rows).toEqual([['Ш', '55.755800'], ['Д', '37.617300']]);
    expect(c.short).toBe('55.75580, 37.61730');
  });
  it('dms: 55.7558 → 55°45′20.9″N, юг/запад → S/W', () => {
    expect(formatCoords(55.7558, 37.6173, 'dms').rows[0][1]).toBe('55°45′20.9″N');
    const sw = formatCoords(-33.5, -70.25, 'dms').rows;
    expect(sw[0][1].endsWith('S')).toBe(true);
    expect(sw[1][1].endsWith('W')).toBe(true);
  });
  it('sk42: X/Y с подсветкой километровых цифр', () => {
    const c = formatCoords(55.7558, 37.6173, 'sk42');
    expect(c.label).toBe('СК-42');
    expect(c.rows[0]).toEqual(['X', '61<em>82</em>341']);
    expect(c.rows[1]).toEqual(['Y', '74<em>13</em>306']);
  });
});

describe('parseCoords', () => {
  it('градусы с точкой', () => {
    expect(parseCoords('55.7558 37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoords('55.7558, 37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoords('55.7558,37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
  });
  it('градусы с запятой как десятичным разделителем', () => {
    expect(parseCoords('55,7558; 37,6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoords('55,7558 37,6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
  });
  it('отрицательные значения (юг/запад)', () => {
    expect(parseCoords('-33.86, 151.21')).toEqual({ lat: -33.86, lon: 151.21 });
    expect(parseCoords('37.8 -122.4')).toEqual({ lat: 37.8, lon: -122.4 });
  });
  it('СК-42: «X 6182341 Y 7413306» → Москва (< 1 м от обратного пересчёта)', () => {
    const p = parseCoords('X 6182341 Y 7413306')!;
    expect(p).not.toBeNull();
    expect(distance(p, { lat: 55.7558, lon: 37.6173 })).toBeLessThan(5);
    const p2 = parseCoords('6182341, 7413306')!;
    expect(p2.lat).toBeCloseTo(p.lat, 9);
  });
  it('мусор → null', () => {
    for (const t of ['', 'abc', '55.7', 'привет мир', '1234', '   ']) expect(parseCoords(t)).toBeNull();
  });
  it('вне диапазона → null (lat 200, lon 500)', () => {
    expect(parseCoords('200 30')).toBeNull();
    expect(parseCoords('50 500')).toBeNull();
    expect(parseCoords('91 10')).toBeNull();
  });
  it('граничные значения принимаются', () => {
    expect(parseCoords('90 180')).toEqual({ lat: 90, lon: 180 });
    expect(parseCoords('0 0')).toEqual({ lat: 0, lon: 0 });
  });
  // BUG: parseCoords не понимает DMS, которые сам же выводит formatCoords('dms'):
  // «55°45′20.9″N 37°37′02.3″E» → числа 55,45,20.9,... → берутся первые два → {lat:55, lon:45} молча.
  it('разбор собственного DMS-вывода (был BUG, исправлен)', () => {
    const p = parseCoords(formatCoords(55.7558, 37.6173, 'dms').short);
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(55.7558, 3);
    expect(p!.lon).toBeCloseTo(37.6173, 3);
  });
  // BUG: порядок чисел жёстко (первое = X); с метками «Y … X …» точка улетает в другую зону (fromSK42 берёт зону из первого числа).
  it('«X Y» в обратном порядке («Y 7413306 X 6182341») не распознаётся как Москва', () => {
    const p = parseCoords('Y 7413306 X 6182341');
    expect(p).not.toBeNull();
    expect(distance(p!, { lat: 55.7558, lon: 37.6173 })).toBeLessThan(5);
  });
});

describe('parseCoords: знак у градусов (ревью Codex)', () => {
  it('«-33° 151°» → южная широта', () => {
    const p = parseCoords('-33° 151°')!;
    expect(p.lat).toBeCloseTo(-33, 6);
    expect(p.lon).toBeCloseTo(151, 6);
  });
  it('«33°S 70°W» → оба отрицательные', () => {
    const p = parseCoords('33°30′S 70°W')!;
    expect(p.lat).toBeCloseTo(-33.5, 6);
    expect(p.lon).toBeCloseTo(-70, 6);
  });
});

describe('toUTM и toSK42InZone (свой рельеф в метрической проекции)', () => {
  it('UTM совпадает с proj4 до сантиметра (север и юг, край зоны)', () => {
    for (const [lat, lon, zone, south] of [[55.7558, 37.6173, 37, false], [-33.45, -70.6667, 19, true], [64.5, 41.9, 37, false], [43.6, 39.7, 37, false]] as const) {
      const [e, n] = proj4('WGS84', `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m`, [lon, lat]);
      const m = toUTM(lat, lon, zone, south);
      expect(Math.abs(m.e - e)).toBeLessThan(0.01);
      expect(Math.abs(m.n - n)).toBeLessThan(0.01);
    }
  });
  it('СК-42 в чужой зоне совпадает с fromSK42 обратно', () => {
    const p = { lat: 55.75, lon: 36.05 }; // зона 7, но считаем в зоне 6
    const g = toSK42InZone(p.lat, p.lon, 6);
    expect(Math.floor(g.y / 1e6)).toBe(6);
    const back = fromSK42(g.x, g.y);
    expect(back.lat).toBeCloseTo(p.lat, 6);
    expect(back.lon).toBeCloseTo(p.lon, 6);
  });
});
