// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { COV_MAX_HEIGHTS, defaults, importText, Mark, Route, save, State, toGeoJSON, toGPX, toKML } from './store';
import { DEFAULT_RADIO } from './radio';

const mark = (name: string, lat: number, lon: number, note = ''): Mark =>
  ({ id: 'x', name, note, lat, lon, color: '#fff', folder: '', created: 0 });
const route = (name: string, pts: [number, number][]): Route => ({ id: 'r', name, pts });
const withData = (marks: Mark[], routes: Route[]): State => ({ ...defaults(), marks, routes });

describe('defaults', () => {
  it('радиопараметры = DEFAULT_RADIO, но отдельная копия; сессии независимы', () => {
    const a = defaults(), b = defaults();
    expect(a.radio).toEqual(DEFAULT_RADIO);
    expect(a.radio).not.toBe(DEFAULT_RADIO);
    a.radio.freqMHz = 1;
    a.marks.push(mark('m', 1, 1));
    expect(b.radio.freqMHz).toBe(DEFAULT_RADIO.freqMHz);
    expect(b.marks).toEqual([]);
    expect(a.coverage.heights).not.toBe(b.coverage.heights);
  });
  it('разумные значения', () => {
    const d = defaults();
    expect(d.v).toBe(2); // v2: отмывка рельефа по умолчанию (миграция в migrate)
    expect(d.station).toBeNull();
    expect(d.droneH).toBeGreaterThan(0);
    expect(d.coverage.heights.length).toBeGreaterThan(0);
    expect(d.coverage.heights.length).toBeLessThanOrEqual(COV_MAX_HEIGHTS);
    expect(d.coverage.compare).toBe(false); // по умолчанию зона считает одну высоту — S.droneH
    expect('heightIdx' in d.coverage).toBe(false);
    expect(['takeoff', 'terrain']).toContain(d.altMode);
  });
});

describe('importText: GeoJSON', () => {
  it('точки и линии, [lon,lat] → lat/lon, имена и заметки', () => {
    const gj = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [37.6, 55.7] }, properties: { name: 'Точка', note: 'заметка' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [30.3, 59.9] }, properties: { name: 'СПб', description: 'описание' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[37, 55], [38, 56], [39, 57]] }, properties: { name: 'Трасса' } },
      ],
    });
    const { marks, routes } = importText(gj, 'файл.geojson');
    expect(marks.map((m) => [m.name, m.lat, m.lon, m.note, m.folder])).toEqual([
      ['Точка', 55.7, 37.6, 'заметка', 'файл.geojson'], ['СПб', 59.9, 30.3, 'описание', 'файл.geojson'],
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe('Трасса');
    expect(routes[0].pts).toEqual([[37, 55], [38, 56], [39, 57]]);
  });
  it('одиночный Feature; Point без имени → «Метка»; высота (3-е число) игнорируется', () => {
    const { marks } = importText(JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 20, 300] }, properties: {} }), 'f');
    expect(marks).toHaveLength(1);
    expect(marks[0].name).toBe('Метка');
    expect(marks[0]).toMatchObject({ lat: 20, lon: 10 });
  });
  it('лишние пробелы в начале; неподдерживаемые геометрии пропускаются', () => {
    const r = importText('  \n ' + JSON.stringify({ type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon', coordinates: [] } }, null] }), 'f');
    expect(r).toEqual({ marks: [], routes: [] });
  });
  it('неверные координаты отбрасываются: lat 200, lon 500, строки, NaN/null', () => {
    const pt = (c: unknown) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { name: 'p' } });
    const gj = JSON.stringify({ type: 'FeatureCollection', features: [
      pt([10, 200]), pt([500, 10]), pt(['10', '20']), pt([null, 5]), pt([]), pt([30, 40]),
    ] });
    const { marks } = importText(gj, 'f');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ lat: 40, lon: 30 });
  });
  it('в линии вырезаются нечисловые вершины; <2 вершин → маршрут не создаётся', () => {
    const ls = (c: unknown) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} });
    const { routes } = importText(JSON.stringify({ type: 'FeatureCollection', features: [
      ls([[1, 2], ['a', 3], [3, 4]]), ls([[1, 2]]), ls([[1, 2], [null, null]]),
    ] }), 'f');
    expect(routes).toHaveLength(1);
    expect(routes[0].pts).toEqual([[1, 2], [3, 4]]);
  });
  // BUG: вершины маршрута проверяются только на конечность, диапазон (|lat|≤90, |lon|≤180) не проверяется,
  // в отличие от меток — линия с lat 200 импортируется как есть.
  it('вершины линии с lat 200 отбрасываются так же, как у меток', () => {
    const { routes } = importText(JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 200], [11, 300], [12, 13], [14, 15]] }, properties: {} }), 'f');
    for (const r of routes) for (const [lon, lat] of r.pts) { expect(Math.abs(lat)).toBeLessThanOrEqual(90); expect(Math.abs(lon)).toBeLessThanOrEqual(180); }
  });
  it('HTML в имени остаётся строкой и не интерпретируется; имя обрезается до 120 символов', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { marks } = importText(JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: evil + 'x'.repeat(200) } }), 'f');
    expect(marks[0].name.startsWith(evil)).toBe(true);
    expect(marks[0].name.length).toBe(120);
    expect(typeof marks[0].name).toBe('string');
  });
  it('нестроковые name/note → пустые значения, не падение', () => {
    const { marks } = importText(JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: { a: 1 }, note: 5 } }), 'f');
    expect(marks[0].name).toBe('Метка');
    expect(marks[0].note).toBe('');
  });
});

describe('importText: GPX', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="55.75" lon="37.61"><name>Точка А</name><desc>описание</desc></wpt>
    <wpt lat="59.9" lon="30.3"><name>Б</name></wpt>
    <rte><name>Маршрут</name><rtept lat="55" lon="37"/><rtept lat="56" lon="38"/></rte>
    <trk><name>Трек</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/><trkpt lat="5" lon="6"/></trkseg></trk>
  </gpx>`;
  it('wpt, rte, trk', () => {
    const { marks, routes } = importText(gpx, 'g.gpx');
    expect(marks.map((m) => [m.name, m.lat, m.lon, m.note])).toEqual([['Точка А', 55.75, 37.61, 'описание'], ['Б', 59.9, 30.3, '']]);
    expect(routes.map((r) => r.name).sort()).toEqual(['Маршрут', 'Трек']);
    expect(routes.find((r) => r.name === 'Маршрут')!.pts).toEqual([[37, 55], [38, 56]]);
    expect(routes.find((r) => r.name === 'Трек')!.pts).toEqual([[2, 1], [4, 3], [6, 5]]);
  });
  it('wpt с lat 200 и lon 999 отбрасывается', () => {
    const { marks } = importText('<gpx><wpt lat="200" lon="10"><name>a</name></wpt><wpt lat="10" lon="999"><name>b</name></wpt><wpt lat="10" lon="20"><name>ok</name></wpt></gpx>', 'g');
    expect(marks.map((m) => m.name)).toEqual(['ok']);
  });
  // BUG: wpt без атрибутов lat/lon: +getAttribute() === +null === 0 → метка падает в точку (0°, 0°) в Гвинейском заливе.
  it('wpt без lat/lon не должен превращаться в метку (0,0)', () => {
    const { marks } = importText('<gpx><wpt><name>без координат</name></wpt><wpt lat="" lon=""><name>пусто</name></wpt></gpx>', 'g');
    expect(marks).toHaveLength(0);
  });
  it('HTML/скрипт в имени остаётся текстом', () => {
    const { marks } = importText('<gpx><wpt lat="1" lon="2"><name>&lt;b&gt;жирный&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;</name></wpt></gpx>', 'g');
    expect(marks[0].name).toBe('<b>жирный</b><script>alert(1)</script>');
  });
});

describe('importText: KML', () => {
  it('Point и LineString', () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name>Точка</name><description>док</description><Point><coordinates>37.6,55.7,120</coordinates></Point></Placemark>
      <Placemark><name>Линия</name><LineString><coordinates>1,2,0 3,4,0
        5,6,0</coordinates></LineString></Placemark></Document></kml>`;
    const { marks, routes } = importText(kml, 'k.kml');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ name: 'Точка', note: 'док', lat: 55.7, lon: 37.6 });
    expect(routes).toHaveLength(1);
    expect(routes[0].pts.map((p) => p.slice(0, 2))).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
  it('LineString с длинным списком координат (> 500 символов) импортируется целиком', () => {
    const pts: string[] = [];
    for (let i = 0; i < 400; i++) pts.push(`${(30 + i * 0.001).toFixed(4)},${(50 + i * 0.001).toFixed(4)},0`);
    const coords = pts.join(' ');
    expect(coords.length).toBeGreaterThan(5000);
    const { routes } = importText(`<kml><Document><Placemark><name>Длинный</name><LineString><coordinates>${coords}</coordinates></LineString></Placemark></Document></kml>`, 'k');
    expect(routes).toHaveLength(1);
    expect(routes[0].pts).toHaveLength(400);
    expect(routes[0].pts[399][0]).toBeCloseTo(30.399, 4);
  });
  it('Point с lat 200 отбрасывается', () => {
    const { marks } = importText('<kml><Placemark><name>x</name><Point><coordinates>10,200</coordinates></Point></Placemark></kml>', 'k');
    expect(marks).toHaveLength(0);
  });
  it('Point без lat (одно число) отбрасывается', () => {
    const { marks } = importText('<kml><Placemark><name>x</name><Point><coordinates>10</coordinates></Point></Placemark></kml>', 'k');
    expect(marks).toHaveLength(0);
  });
});

describe('importText: битые файлы', () => {
  it('мусор, пустая строка, оборванный JSON/KML не роняют процесс: исключение Error или пустой результат', () => {
    for (const bad of ['', '   ', 'просто текст', '<<<>>>', '{"type": "FeatureCollection", ', '{', '[1,2,3]', '<kml><Placemark>']) {
      let r: { marks: unknown[]; routes: unknown[] } | undefined;
      try { r = importText(bad, 'f'); } catch (e) { expect(e).toBeInstanceOf(Error); continue; }
      expect(r.marks).toHaveLength(0);
      expect(r.routes).toHaveLength(0);
    }
  });
  it('незакрытые теги: либо исключение Error, либо результат корректной формы (happy-dom парсит XML мягко, браузер даёт parsererror)', () => {
    for (const bad of ['<gpx><wpt lat="1" lon="2"><name>a</gpx>', '<a><b></a>']) {
      try {
        const r = importText(bad, 'f');
        expect(Array.isArray(r.marks)).toBe(true);
        expect(Array.isArray(r.routes)).toBe(true);
      } catch (e) { expect(e).toBeInstanceOf(Error); }
    }
  });
  it('битый JSON — исключение', () => {
    expect(() => importText('{"a":', 'f')).toThrow(SyntaxError);
  });
  it('валидный JSON не-коллекция → пусто', () => {
    expect(importText('{"foo": 1}', 'f')).toEqual({ marks: [], routes: [] });
  });
});

describe('экспорт', () => {
  const nasty = `A<b>&"x'y</b> & «ёлка»`;
  const st = withData(
    [mark(nasty, 55.5, 37.5, `заметка <i>"1" & 'два'`), mark('Простая', -33.8, 151.2)],
    [route(`R<1>&"2"'3'`, [[37, 55], [38, 56], [39.5, 57.25]])],
  );

  it('toGPX экранирует <>&"\' (нет «сырых» символов внутри текста имён)', () => {
    const x = toGPX(st);
    expect(x).not.toContain('<b>');
    expect(x).not.toContain('<i>');
    expect(x).toContain('&#60;b&#62;');
    expect(x).toContain('&#38;');
    expect(x).toContain('&#34;');
    expect(x).toContain('&#39;');
    expect(x.startsWith('<?xml')).toBe(true);
  });
  it('toKML экранирует так же', () => {
    const x = toKML(st);
    expect(x).not.toContain('<b>');
    expect(x).toContain('&#60;b&#62;');
    expect(x).toContain('<coordinates>37,55 38,56 39.5,57.25</coordinates>');
  });
  it('GPX: экспорт → импорт — те же имена, заметки, координаты', () => {
    const { marks, routes } = importText(toGPX(st), 'rt.gpx');
    expect(marks.map((m) => m.name)).toEqual([nasty, 'Простая']);
    expect(marks[0].note).toBe(`заметка <i>"1" & 'два'`);
    expect(marks.map((m) => [m.lat, m.lon])).toEqual([[55.5, 37.5], [-33.8, 151.2]]);
    expect(routes[0].name).toBe(`R<1>&"2"'3'`);
    expect(routes[0].pts).toEqual([[37, 55], [38, 56], [39.5, 57.25]]);
  });
  it('KML: экспорт → импорт — те же имена, заметки, координаты', () => {
    const { marks, routes } = importText(toKML(st), 'rt.kml');
    expect(marks.map((m) => m.name)).toEqual([nasty, 'Простая']);
    expect(marks[0].note).toBe(`заметка <i>"1" & 'два'`);
    expect(marks.map((m) => [m.lat, m.lon])).toEqual([[55.5, 37.5], [-33.8, 151.2]]);
    expect(routes[0].name).toBe(`R<1>&"2"'3'`);
    expect(routes[0].pts).toEqual([[37, 55], [38, 56], [39.5, 57.25]]);
  });
  it('GeoJSON: экспорт → импорт; станция тоже попадает как точка', () => {
    const s2: State = { ...st, station: { lat: 10, lon: 20, antH: 3, name: 'Пульт' } };
    const gj = toGeoJSON(s2);
    expect(gj.type).toBe('FeatureCollection');
    const { marks, routes } = importText(JSON.stringify(gj), 'rt.geojson');
    expect(marks.map((m) => m.name)).toEqual([nasty, 'Простая', 'Пульт']);
    expect(marks[0].note).toBe(`заметка <i>"1" & 'два'`);
    expect(routes[0].pts).toEqual([[37, 55], [38, 56], [39.5, 57.25]]);
  });
  it('пустой проект экспортируется и импортируется без ошибок', () => {
    const e = defaults();
    expect(importText(toGPX(e), 'e')).toEqual({ marks: [], routes: [] });
    expect(importText(toKML(e), 'e')).toEqual({ marks: [], routes: [] });
    expect(importText(JSON.stringify(toGeoJSON(e)), 'e')).toEqual({ marks: [], routes: [] });
  });
  it('экспортный XML валиден (нет parsererror)', () => {
    for (const x of [toGPX(st), toKML(st)]) {
      const doc = new DOMParser().parseFromString(x, 'application/xml');
      expect(doc.querySelector('parsererror')).toBeNull();
    }
  });
});

describe('sanitize / restoreProject (ревью Codex)', () => {
  it('битые записи в копии отбрасываются, запуск не ломается', async () => {
    const { restoreProject } = await import('./store');
    const st = restoreProject(JSON.stringify({
      marks: [null, 5, { lat: 55, lon: 37, name: 7 }, { lat: 'x', lon: 1 }],
      routes: [null, { pts: [[37, 55], [200, 55], [38, 56]] }, { pts: 'bad' }],
      station: { lat: 99, lon: 0 }, droneH: -5, radio: { freqMHz: 'x', k: 0 }, coverage: { heights: [null, 50] },
      map: { center: ['a', 1], zoom: 99 }, coordFormat: 'evil',
    }));
    expect(st.marks).toHaveLength(1);
    expect(typeof st.marks[0].id).toBe('string');
    expect(st.marks[0].name).toBe('Метка');
    expect(st.routes).toHaveLength(1);
    expect(st.routes[0].pts).toEqual([[37, 55], [38, 56]]);
    expect(st.station).toBeNull();
    expect(st.droneH).toBe(100);
    expect(st.radio.freqMHz).toBe(2440);
    expect(st.radio.k).toBeCloseTo(4 / 3);
    expect(st.coverage.heights).toEqual([50]);
    expect(st.map.zoom).toBe(12);
    expect(st.coordFormat).toBe('sk42');
  });
});

describe('вторая линия (видео) в состоянии', () => {
  it('по умолчанию: видео включено, аналог 5.8 ГГц; управление — прежнее', async () => {
    const { defaults } = await import('./store');
    const d = defaults();
    expect(d.video.enabled).toBe(true);
    expect(d.video.presetId).toBe('vtx58');
    expect(d.video.radio.freqMHz).toBe(5800);
    expect(d.video.radio).not.toBe(d.radio);
    expect(d.radio).toEqual(DEFAULT_RADIO);
  });

  it('старый проект без video: управление сохранено, видео — по умолчанию', async () => {
    const { restoreProject, defaults } = await import('./store');
    const st = restoreProject(JSON.stringify({ radio: { freqMHz: 868, txPowerDbm: 24 }, presetId: 'crsf', coverage: { radius: 5000 } }));
    expect(st.radio.freqMHz).toBe(868);
    expect(st.presetId).toBe('crsf');
    expect(st.video).toEqual(defaults().video);
    expect(st.coverage.line).toBe('both');
  });

  it('video из недоверенных данных: числа проверяются, мусор заменяется значениями по умолчанию', async () => {
    const { restoreProject } = await import('./store');
    const st = restoreProject(JSON.stringify({
      video: { enabled: 'yes', presetId: 5, radio: { freqMHz: 0, txPowerDbm: 'x', k: -1, sensDbm: -95, lossDb: 1e12 } },
      coverage: { line: 'evil' },
    }));
    expect(st.video.enabled).toBe(true);
    expect(st.video.presetId).toBe('vtx58');
    expect(st.video.radio.freqMHz).toBe(5800);
    expect(st.video.radio.txPowerDbm).toBe(28);
    expect(st.video.radio.k).toBeCloseTo(4 / 3);
    expect(st.video.radio.sensDbm).toBe(-95);
    expect(st.video.radio.lossDb).toBe(4);
    expect(st.coverage.line).toBe('both');
    expect(restoreProject(JSON.stringify({ video: 'junk' })).video.radio.freqMHz).toBe(5800);
    expect(restoreProject(JSON.stringify({ video: { enabled: false } })).video.enabled).toBe(false);
  });
});

describe('save: ошибка записи', () => {
  it('квота → onError (а не тихий провал); успешная запись — без onError', () => {
    vi.useFakeTimers();
    let full = true;
    const setItem = vi.fn(() => { if (full) throw new DOMException('quota', 'QuotaExceededError'); });
    vi.stubGlobal('localStorage', { setItem });
    try {
      const err = vi.fn();
      save(defaults(), err);
      vi.advanceTimersByTime(400);
      expect(err).toHaveBeenCalledTimes(1);
      full = false;
      save(defaults(), err);
      vi.advanceTimersByTime(400);
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('зона: миграция старых проектов (heights/heightIdx → одна высота дрона + «Сравнить высоты»)', () => {
  it('старый проект: список высот сохранён, сравнение включено, heightIdx убран; droneH не тронут', async () => {
    const { restoreProject } = await import('./store');
    const st = restoreProject(JSON.stringify({ droneH: 120, coverage: { radius: 5000, heights: [50, 150, 300], heightIdx: 2, show: 'minh', line: 'rc', opacity: 0.4 } }));
    expect(st.coverage).toEqual({ radius: 5000, compare: true, heights: [50, 150, 300], show: 'minh', opacity: 0.4, line: 'rc' });
    expect(st.droneH).toBe(120);
  });
  it('старый проект с одной высотой — сравнение выключено; без поля coverage — значения по умолчанию', async () => {
    const { restoreProject } = await import('./store');
    expect(restoreProject(JSON.stringify({ coverage: { heights: [80], heightIdx: 0 } })).coverage).toMatchObject({ compare: false, heights: [80] });
    expect(restoreProject(JSON.stringify({ marks: [] })).coverage).toEqual(defaults().coverage);
  });
  it('старый лимит 12 высот → не больше COV_MAX_HEIGHTS, равномерно, с крайними', async () => {
    const { restoreProject } = await import('./store');
    const hs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const c = restoreProject(JSON.stringify({ coverage: { heights: hs, heightIdx: 11 } })).coverage;
    expect(c.heights).toHaveLength(COV_MAX_HEIGHTS);
    expect(c.heights[0]).toBe(10);
    expect(c.heights[c.heights.length - 1]).toBe(120);
    expect([...c.heights].sort((a, b) => a - b)).toEqual(c.heights);
  });
  it('новый формат: compare сохраняется как есть, пустой список допустим, мусор отбрасывается', async () => {
    const { restoreProject, sanitize } = await import('./store');
    expect(restoreProject(JSON.stringify({ coverage: { compare: true, heights: [] } })).coverage).toMatchObject({ compare: true, heights: [] });
    expect(restoreProject(JSON.stringify({ coverage: { compare: false, heights: [300, 30, 30, -1, 'x'] } })).coverage).toMatchObject({ compare: false, heights: [30, 300] });
    expect(restoreProject(JSON.stringify({ coverage: { compare: 'yes', radius: 5000 } })).coverage.compare).toBe(false);
    // sanitize без migrate (данные уже нового формата): лишний heightIdx не попадает в состояние.
    const st = sanitize({ ...defaults(), coverage: { ...defaults().coverage, heightIdx: 3 } as State['coverage'] });
    expect('heightIdx' in st.coverage).toBe(false);
  });
  it('load: старый проект из localStorage мигрирует так же', async () => {
    const { load } = await import('./store');
    const raw = JSON.stringify({ coverage: { heights: [40, 400], heightIdx: 1 } });
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'radius.project.v1' ? raw : null) });
    try {
      expect(load().coverage).toMatchObject({ compare: true, heights: [40, 400] });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('миграция v1 → v2: отмывка рельефа по умолчанию', () => {
  it('старый проект (v1, отмывка выключена прежним умолчанием) — включаем', async () => {
    const { restoreProject } = await import('./store');
    const st = restoreProject(JSON.stringify({ v: 1, map: { base: 'topo', hillshade: false, contours: true } }));
    expect(st.map.hillshade).toBe(true);
    expect(st.map.base).toBe('topo');
    expect(st.v).toBe(2);
  });
  it('проект без версии — тоже старый', async () => {
    const { restoreProject } = await import('./store');
    expect(restoreProject(JSON.stringify({ map: { hillshade: false } })).map.hillshade).toBe(true);
  });
  it('v2: выбор пользователя «без отмывки» сохраняется', async () => {
    const { restoreProject } = await import('./store');
    expect(restoreProject(JSON.stringify({ v: 2, map: { hillshade: false } })).map.hillshade).toBe(false);
  });
  it('новый проект — отмывка включена', () => {
    expect(defaults().map.hillshade).toBe(true);
  });
});
