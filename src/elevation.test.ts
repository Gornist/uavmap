import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemGrid, DemMissingError, sampleGrid, sampleRay, demPlan, demPixelM, fetchGrid, setSharedDem, elevationAt } from './elevation';
import { resetPrimary, reportPrimary, AWS_PREFIX } from './demNet';
import { lonLatToPixel, R_EARTH } from './geo';

/** Сетка 4×3 с линейным полем f(x, y) = 10·x + 100·y (x,y — индексы ячеек): билинейная интерполяция точна. */
function linGrid(): DemGrid {
  const width = 4, height = 3, data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = 10 * x + 100 * y;
  return { z: 12, px0: 1000, py0: 2000, width, height, data };
}

describe('sampleGrid (билинейная; значение ячейки — в её центре, +0.5 px)', () => {
  const g = linGrid();
  it('в центрах ячеек — точные значения', () => {
    expect(sampleGrid(g, 1000.5, 2000.5)).toBeCloseTo(0, 9);
    expect(sampleGrid(g, 1001.5, 2000.5)).toBeCloseTo(10, 9);
    expect(sampleGrid(g, 1000.5, 2001.5)).toBeCloseTo(100, 9);
    expect(sampleGrid(g, 1002.5, 2001.5)).toBeCloseTo(120, 9);
  });
  it('между центрами — линейная интерполяция', () => {
    expect(sampleGrid(g, 1001.0, 2000.5)).toBeCloseTo(5, 6);
    expect(sampleGrid(g, 1000.5, 2001.0)).toBeCloseTo(50, 6);
    expect(sampleGrid(g, 1001.25, 2000.75)).toBeCloseTo(10 * 0.75 + 100 * 0.25, 5);
  });
  it('билинейность на нелинейных данных: среднее четырёх углов в центре квадрата', () => {
    const q: DemGrid = { z: 12, px0: 0, py0: 0, width: 2, height: 2, data: new Float32Array([0, 10, 20, 100]) };
    expect(sampleGrid(q, 1.0, 1.0)).toBeCloseTo(32.5, 6);
  });
  it('за границами — зажимается к краю, без NaN', () => {
    expect(sampleGrid(g, -5000, -5000)).toBeCloseTo(0, 6);
    const far = sampleGrid(g, 9999, 9999);
    expect(Number.isFinite(far)).toBe(true);
    expect(far).toBeCloseTo(sampleGrid(g, 1003.499, 2002.499), 2);
  });
  it('учитывает смещение px0/py0', () => {
    const g2 = { ...linGrid(), px0: 0, py0: 0 };
    expect(sampleGrid(g2, 1.5, 1.5)).toBeCloseTo(110, 9);
  });
});

describe('DemMissingError', () => {
  it('Error с числом тайлов в сообщении и поле tiles', () => {
    const e = new DemMissingError(7);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(DemMissingError);
    expect(e.tiles).toBe(7);
    expect(e.message).toContain('7');
    expect(e.name).toBe('DemMissingError');
  });
  it('различим через instanceof в try/catch', () => {
    let caught: unknown;
    try { throw new DemMissingError(3); } catch (x) { caught = x; }
    expect(caught instanceof DemMissingError).toBe(true);
    expect(caught instanceof Error).toBe(true);
  });
});

/** Сетка вокруг точки (lat 0, lon 10): пульт в узле (20, 20) мозаики 80×40. */
function rayGrid(fill: (x: number, y: number) => number) {
  const z = 12, lat = 0, lon = 10;
  const [ox, oy] = lonLatToPixel(lon, lat, z);
  const g: DemGrid = { z, px0: Math.floor(ox) - 20, py0: Math.floor(oy) - 20, width: 80, height: 40, data: new Float32Array(80 * 40) };
  for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) g.data[y * 80 + x] = fill(x, y);
  const mpp = (2 * Math.PI * R_EARTH) / (256 * 2 ** z);
  return { g, lat, lon, mpp, ox, oy };
}

describe('sampleRay (максимум в окне)', () => {
  it('узкий хребет в 1 пиксель между отсчётами не теряется (билинейка занизила бы)', () => {
    const { g, lat, lon, mpp, ox, oy } = rayGrid((x) => (x === 20 + 5 ? 500 : 100));
    const out = new Float64Array(6);
    sampleRay(g, lat, lon, 90, 4 * mpp, 6, out);
    expect(out[1]).toBe(500);
    for (const k of [1, 2]) expect(sampleGrid(g, ox + 4 * k, oy)).toBeLessThan(400);
  });
  it('хребет ближе полушага от пульта попадает в out[1] (ревью Codex: зазор у антенны)', () => {
    // шаг 8 px, хребет в 1 px от пульта на восток — раньше окно out[1] начиналось с 4 px и его пропускало
    const { g, lat, lon, mpp } = rayGrid((x) => (x === 20 + 1 ? 500 : 100));
    const out = new Float64Array(4);
    sampleRay(g, lat, lon, 90, 8 * mpp, 4, out);
    expect(out[1]).toBe(500);
  });
  it('ровная поверхность: везде та же высота, концы точные', () => {
    const { g, lat, lon, mpp } = rayGrid(() => 123.5);
    const out = new Float64Array(10);
    sampleRay(g, lat, lon, 45, 2 * mpp, 10, out);
    for (const v of out) expect(v).toBeCloseTo(123.5, 4);
  });
  it('out[0] — билинейно в точке пульта, а не максимум соседей', () => {
    const { g, lat, lon, ox, oy, mpp } = rayGrid((x, y) => 10 * x + 100 * y);
    const out = new Float64Array(4);
    sampleRay(g, lat, lon, 90, 3 * mpp, 4, out);
    expect(out[0]).toBeCloseTo(sampleGrid(g, ox, oy), 6);
    expect(out[1]).toBeGreaterThan(out[0]); // на восток рельеф растёт: окно даёт максимум, не среднее
  });
  it('у края мозаики без NaN', () => {
    const { g, lat, lon, mpp } = rayGrid((x) => x);
    const out = new Float64Array(200);
    sampleRay(g, lat, lon, 270, 5 * mpp, 200, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('demPlan', () => {
  it('пиксель 9–26 м, шаг не меньше пикселя и не меньше D/400', () => {
    for (const lat of [0, 30, 55, 65]) {
      const { z, step } = demPlan(lat, 30000);
      const px = demPixelM(lat, z);
      expect(px).toBeGreaterThan(9);
      expect(px).toBeLessThan(26);
      expect(step).toBeGreaterThanOrEqual(px);
      expect(step).toBeGreaterThanOrEqual(30000 / 400);
    }
  });
  it('лимит тайлов понижает z, шаг не меньше нового пикселя', () => {
    const a = demPlan(55, 5000), b = demPlan(55, 5000, (z) => 4 ** (z - 6), 256);
    expect(b.z).toBeLessThan(a.z);
    expect(b.step).toBeGreaterThanOrEqual(demPixelM(55, b.z));
  });
});


describe('загрузка тайлов: зависший запрос', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetPrimary(); });

  // Terrarium: R*256 + G + B/256 − 32768 → пиксель (128, 100, 0) = 100 м.
  function stubCanvas(size = 512) {
    vi.stubGlobal('createImageBitmap', async () => ({ width: size, height: size }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4).map((_, i) => [128, 100, 0, 255][i % 4]) }) };
      }
    });
  }

  it('основной источник завис — тайл склеивается из четырёх тайлов запасного (AWS)', async () => {
    vi.useFakeTimers();
    stubCanvas(256); // тайлы AWS — 256 px
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => { urls.push(u); return u.startsWith(AWS_PREFIX) ? Promise.resolve({ ok: true, blob: async () => new Blob() }) : new Promise(() => {}); });
    const g = fetchGrid([{ lat: 10.123, lon: 20.456 }], 10, 0);
    await vi.advanceTimersByTimeAsync(7000);
    const r = await g;
    expect(urls.filter((u) => u.startsWith(AWS_PREFIX))).toHaveLength(4);
    expect(urls.filter((u) => u.startsWith(AWS_PREFIX)).every((u) => u.includes('/terrarium/10/'))).toBe(true); // источник z9 → AWS z10
    expect(r.data[0]).toBe(100);
  });

  it('основной молчит — запасной запрашивается через 1,5 с, тайл есть задолго до таймаута', async () => {
    vi.useFakeTimers();
    stubCanvas(256);
    vi.stubGlobal('fetch', (u: string) => (u.startsWith(AWS_PREFIX) ? Promise.resolve({ ok: true, blob: async () => new Blob() }) : new Promise(() => {})));
    let done = false;
    const g = fetchGrid([{ lat: 50.5, lon: 50.5 }], 10, 0).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(1400);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
    expect((await g).data[0]).toBe(100);
    await vi.advanceTimersByTimeAsync(6000); // основной дождался таймаута — без висящих промисов
  });

  it('предохранитель открыт, но тайл основного в кеше (офлайн-район) — из кеша, без запасного', async () => {
    stubCanvas();
    reportPrimary(false); reportPrimary(false); // основной «лежит»
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => { urls.push(u); return new Promise(() => {}); });
    vi.stubGlobal('caches', { match: async () => ({ ok: true, blob: async () => new Blob() }) });
    const r = await fetchGrid([{ lat: 55.5, lon: 55.5 }], 10, 0);
    expect(r.data[0]).toBe(100);
    expect(urls).toHaveLength(0);
  });

  it('после двух сбоев основного — сразу запасной, без ожидания таймаута', async () => {
    vi.useFakeTimers();
    stubCanvas(256);
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => { urls.push(u); return u.startsWith(AWS_PREFIX) ? Promise.resolve({ ok: true, blob: async () => new Blob() }) : new Promise(() => {}); });
    const g1 = fetchGrid([{ lat: 40.5, lon: 40.5 }, { lat: 40.5, lon: 41.5 }], 10, 0); // два тайла источника
    await vi.advanceTimersByTimeAsync(7000);
    await g1;
    const before = urls.filter((u) => !u.startsWith(AWS_PREFIX)).length;
    const g2 = fetchGrid([{ lat: 45.5, lon: 45.5 }], 10, 0);
    await vi.advanceTimersByTimeAsync(10);
    await g2;
    expect(urls.filter((u) => !u.startsWith(AWS_PREFIX)).length).toBe(before); // к основному больше не ходили
  });

  it('ответ сервера с ошибкой не повторяет — сразу «нет данных»', async () => {
    stubCanvas();
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return { ok: false, status: 404 }; });
    await expect(fetchGrid([{ lat: 11.5, lon: 21.5 }], 10, 0)).rejects.toBeInstanceOf(DemMissingError);
    expect(calls).toBe(1);
  });

  it('висят оба источника — ошибка «нет данных», а не вечная загрузка', async () => {
    vi.useFakeTimers();
    stubCanvas();
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const g = fetchGrid([{ lat: 12.5, lon: 22.5 }], 10, 0);
    const done = expect(g).rejects.toBeInstanceOf(DemMissingError);
    await vi.advanceTimersByTimeAsync(41000);
    await done;
  });
});

describe('общий источник тайлов (demSource) и запасной запрос', () => {
  afterEach(() => { setSharedDem(null); vi.unstubAllGlobals(); resetPrimary(); });
  const tile = (v: number) => ({ width: 512, height: 512, data: new Float32Array(512 * 512).fill(v) });

  it('тайл из общего источника — свой запрос не нужен', async () => {
    let fetched = 0;
    vi.stubGlobal('fetch', async () => { fetched++; return { ok: false, status: 500 }; });
    setSharedDem(async () => tile(321));
    const g = await fetchGrid([{ lat: 30.5, lon: 30.5 }], 10, 0);
    expect(g.data[0]).toBe(321);
    expect(fetched).toBe(0);
  });

  it('общий источник не отдал (старый Chrome офлайн, сбой) — берём своим запросом', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 512, height: 512 }));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4).map((_, i) => [128, 100, 0, 255][i % 4]) }) }; }
    });
    let fetched = 0;
    vi.stubGlobal('fetch', async () => { fetched++; return { ok: true, blob: async () => new Blob() }; });
    setSharedDem(async () => { throw new Error('offline'); });
    const g = await fetchGrid([{ lat: 31.5, lon: 31.5 }], 10, 0);
    expect(g.data[0]).toBe(100);
    expect(fetched).toBe(1);
  });

  it('общий источник занят дольше 250 мс — свой запрос параллельно, берём первый', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('createImageBitmap', async () => ({ width: 512, height: 512 }));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4).map((_, i) => [128, 100, 0, 255][i % 4]) }) }; }
    });
    let fetched = 0;
    vi.stubGlobal('fetch', async () => { fetched++; return { ok: true, blob: async () => new Blob() }; });
    setSharedDem(() => new Promise(() => {})); // очередь воркера не двигается
    const g = fetchGrid([{ lat: 33.5, lon: 33.5 }], 10, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect((await g).data[0]).toBe(100);
    expect(fetched).toBe(1);
    vi.useRealTimers();
  });

  it('виртуальный тайл 256 px — нужная четверть тайла источника 512 px', async () => {
    // Значение = номер четверти (0..3) — проверяем, что каждый виртуальный тайл взял свою.
    const t = new Float32Array(512 * 512);
    for (let r = 0; r < 512; r++) for (let c = 0; c < 512; c++) t[r * 512 + c] = (c >= 256 ? 1 : 0) + (r >= 256 ? 2 : 0);
    let calls = 0;
    setSharedDem(async () => { calls++; return { width: 512, height: 512, data: t }; });
    // Точка в правой нижней четверти виртуального уровня 11 → тайл источника z10.
    const g = await fetchGrid([{ lat: 34.6, lon: 34.6 }], 11, 300); // запас 300 px — захватит соседние виртуальные тайлы
    const vals = new Set(Array.from(g.data));
    expect(vals.size).toBeGreaterThan(1);
    for (const v of vals) expect([0, 1, 2, 3]).toContain(v);
    // Виртуальные тайлы одного источника не качают его повторно.
    const srcTiles = new Set<string>();
    for (let ty = g.py0 / 256; ty < (g.py0 + g.height) / 256; ty++) for (let tx = g.px0 / 256; tx < (g.px0 + g.width) / 256; tx++) srcTiles.add(`${tx >> 1}/${ty >> 1}`);
    expect(calls).toBe(srcTiles.size);
  });

  it('высота точки — с виртуального z13 (тайл источника z12), как у профиля и офлайн-районов', async () => {
    const asked: number[] = [];
    setSharedDem(async (z) => { asked.push(z); return tile(777); });
    expect(await elevationAt({ lat: 35.7, lon: 35.7 })).toBe(777);
    expect(asked[0]).toBe(12);
  });

  it('виртуальный z14 (источник z13, нет по всему миру) — общий источник не спрашиваем', async () => {
    let shared = 0;
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
    setSharedDem(async () => { shared++; return tile(1); });
    await expect(fetchGrid([{ lat: 32.5, lon: 32.5 }], 14, 0)).rejects.toBeInstanceOf(DemMissingError);
    expect(shared).toBe(0);
  });
});
