import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { primaryDown, reportPrimary, resetPrimary, awsTileUrl, loadDemTile, AWS_PREFIX, HEDGE_MS, PRIMARY_TIMEOUT_MS } from './demNet';
import { demTileUrl } from './demTiles';

describe('предохранитель основного источника рельефа', () => {
  beforeEach(() => resetPrimary());
  it('два сбоя подряд — 5 минут сразу запасной, потом снова пробуем основной', () => {
    reportPrimary(false, 1000);
    expect(primaryDown(1000)).toBe(false);
    reportPrimary(false, 1000);
    expect(primaryDown(1001)).toBe(true);
    expect(primaryDown(1000 + 5 * 60 * 1000)).toBe(false);
  });
  it('удачный ответ сбрасывает счёт сбоев', () => {
    reportPrimary(false, 0); reportPrimary(true, 0); reportPrimary(false, 0);
    expect(primaryDown(1)).toBe(false);
  });
});

describe('адрес тайла AWS Terrarium', () => {
  it('z/x/y в адресе', () => {
    expect(awsTileUrl(13, 5010, 2988)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/5010/2988.png');
  });
});

describe('loadDemTile: тайл источника — основной или запасной (AWS)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetPrimary(); });

  // Картинка основного — WebP 512 px, AWS — PNG 256 px (по типу различает заглушка createImageBitmap).
  const okResp = () => Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'image/webp' }) });
  const awsResp = () => Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(['a'], { type: 'image/png' }) });
  /** fetch, который висит, пока его не отменят. */
  const hang = (init?: { signal?: AbortSignal }) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
  function stubCanvas() {
    vi.stubGlobal('createImageBitmap', async (b: Blob) => {
      if (b.type === 'image/broken') throw new Error('не картинка');
      const s = b.type === 'image/webp' ? 512 : 256;
      return { width: s, height: s, close() {} };
    });
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage() {} }; }
    });
  }
  /** fetch: основной ведёт себя как primary(), AWS отвечает сразу. Адреса запросов — в urls. */
  function stubFetch(primary: (init?: { signal?: AbortSignal }) => Promise<unknown>) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string, init?: { signal?: AbortSignal }) => { urls.push(u); return u.startsWith(AWS_PREFIX) ? awsResp() : primary(init); });
    return urls;
  }
  const aws = (urls: string[]) => urls.filter((u) => u.startsWith(AWS_PREFIX));

  it('основной ответил быстро — его картинка, AWS не трогаем', async () => {
    vi.useFakeTimers();
    stubCanvas();
    const urls = stubFetch(okResp);
    const t = await loadDemTile(10, 600, 300);
    expect(t?.kind).toBe('primary');
    expect(urls).toEqual([demTileUrl(10, 600, 300)]);
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 100);
    expect(aws(urls)).toHaveLength(0);
  });

  it('основной завис — через HEDGE_MS параллельно AWS (z+1, четыре тайла), холст 512 px', async () => {
    vi.useFakeTimers();
    stubCanvas();
    const urls = stubFetch(hang);
    let done = false;
    const p = loadDemTile(10, 600, 300).then((t) => { done = true; return t; });
    await vi.advanceTimersByTimeAsync(HEDGE_MS - 100);
    expect(done).toBe(false);
    expect(aws(urls)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    const t = await p;
    expect(t?.kind).toBe('aws');
    expect(aws(urls).sort()).toEqual([awsTileUrl(11, 1200, 600), awsTileUrl(11, 1201, 600), awsTileUrl(11, 1200, 601), awsTileUrl(11, 1201, 601)].sort());
    await vi.advanceTimersByTimeAsync(PRIMARY_TIMEOUT_MS); // основной дождался таймаута — это первый сбой
    expect(primaryDown()).toBe(false);
  });

  it('основной ответил после HEDGE_MS, раньше AWS — запросы AWS отменяются', async () => {
    vi.useFakeTimers();
    stubCanvas();
    let awsAborted = 0;
    vi.stubGlobal('fetch', (u: string, init?: { signal?: AbortSignal }) => {
      if (!u.startsWith(AWS_PREFIX)) return new Promise((r) => setTimeout(() => r(okResp()), HEDGE_MS + 500));
      init?.signal?.addEventListener('abort', () => awsAborted++);
      return hang(init);
    });
    const p = loadDemTile(10, 600, 300, { serial: true });
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 600);
    expect((await p)?.kind).toBe('primary');
    expect(awsAborted).toBe(1); // serial: в полёте был один запрос AWS, следующие не начинались
  });

  it('4xx основного — «тайла нет»: null, в AWS не ходим, предохранитель не трогаем', async () => {
    stubCanvas();
    const urls = stubFetch(() => Promise.resolve({ ok: false, status: 404 }));
    for (let i = 0; i < 3; i++) expect(await loadDemTile(10, 600, 300 + i)).toBeNull();
    expect(aws(urls)).toHaveLength(0);
    expect(primaryDown()).toBe(false);
  });

  it('5xx основного — сразу AWS; два таких сбоя открывают предохранитель', async () => {
    stubCanvas();
    const urls = stubFetch(() => Promise.resolve({ ok: false, status: 503 }));
    expect((await loadDemTile(10, 600, 300))?.kind).toBe('aws');
    expect(aws(urls)).toHaveLength(4);
    await loadDemTile(10, 600, 301);
    expect(primaryDown()).toBe(true);
  });

  it('предохранитель открыт и тайл в кеше — из кеша, без сети', async () => {
    stubCanvas();
    reportPrimary(false); reportPrimary(false);
    const urls = stubFetch(okResp);
    const asked: string[] = [];
    vi.stubGlobal('caches', { match: async (u: string) => { asked.push(u); return { ok: true, blob: async () => new Blob(['c'], { type: 'image/webp' }) }; } });
    const t = await loadDemTile(10, 600, 300);
    expect(t?.kind).toBe('primary');
    expect(asked).toEqual([demTileUrl(10, 600, 300)]);
    expect(urls).toHaveLength(0);
  });

  it('основной отдал не картинку (200 с мусором) — тайл из AWS, а не «нет данных»', async () => {
    stubCanvas();
    const urls = stubFetch(() => Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(['<html>'], { type: 'image/broken' }) }));
    expect((await loadDemTile(10, 600, 300))?.kind).toBe('aws');
    expect(aws(urls)).toHaveLength(4);
  });

  it('предохранитель открыт, в кеше нет — сразу AWS, основной не спрашиваем', async () => {
    stubCanvas();
    reportPrimary(false); reportPrimary(false);
    const urls = stubFetch(okResp);
    vi.stubGlobal('caches', { match: async () => undefined });
    expect((await loadDemTile(10, 600, 300))?.kind).toBe('aws');
    expect(urls.every((u) => u.startsWith(AWS_PREFIX))).toBe(true);
  });

  it('отмена — null, без AWS, предохранитель не открывается', async () => {
    vi.useFakeTimers();
    stubCanvas();
    const urls = stubFetch(hang);
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const p = loadDemTile(10, 600, 300 + i, { signal: ac.signal });
      await vi.advanceTimersByTimeAsync(100);
      ac.abort();
      expect(await p).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(PRIMARY_TIMEOUT_MS);
    expect(aws(urls)).toHaveLength(0);
    expect(primaryDown()).toBe(false);
  });

  it('висят оба источника — null, а не вечное ожидание', async () => {
    vi.useFakeTimers();
    stubCanvas();
    vi.stubGlobal('fetch', () => new Promise(() => {})); // fetch не реагирует даже на отмену
    const p = loadDemTile(10, 600, 300);
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 2 * 10000 + 100);
    expect(await p).toBeNull();
  });

  it('serial — тайлы AWS по одному', async () => {
    stubCanvas();
    reportPrimary(false); reportPrimary(false);
    let inFlight = 0, peak = 0;
    vi.stubGlobal('fetch', async () => { peak = Math.max(peak, ++inFlight); await Promise.resolve(); inFlight--; return { ok: true, status: 200, blob: async () => new Blob(['a'], { type: 'image/png' }) }; });
    expect((await loadDemTile(10, 600, 300, { serial: true }))?.kind).toBe('aws');
    expect(peak).toBe(1);
  });
});
