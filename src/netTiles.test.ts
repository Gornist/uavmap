import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuffer, reliable } from './netTiles';

describe('netTiles: тайлы с таймаутом и повтором', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const ok = () => Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(7) });
  /** fetch, который висит, пока его не отменят (как «вставшая» сеть пульта). */
  const hang = (_: string, init?: { signal?: AbortSignal }) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));

  it('https → свой протокол, остальное не трогаем', () => {
    expect(reliable('https://a.tile.org/{z}/{x}/{y}.png')).toBe('uavnet://a.tile.org/{z}/{x}/{y}.png');
    expect(reliable('uavpm://id/{z}/{x}/{y}')).toBe('uavpm://id/{z}/{x}/{y}');
  });

  it('зависший запрос отменяется по таймауту и повторяется', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal('fetch', (u: string, init?: { signal?: AbortSignal }) => (++n === 1 ? hang(u, init) : ok()));
    const p = fetchBuffer('https://x/1.png');
    await vi.advanceTimersByTimeAsync(10500);
    expect((await p).byteLength).toBe(7);
    expect(n).toBe(2);
  });

  it('два зависания — ошибка, а не вечное ожидание', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hang);
    const p = fetchBuffer('https://x/2.png');
    const done = expect(p).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(21000);
    await done;
  });

  it('ответ сервера с ошибкой не повторяется', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return { ok: false, status: 404 }; });
    await expect(fetchBuffer('https://x/3.png')).rejects.toThrow('HTTP 404');
    expect(n).toBe(1);
  });

  it('отмена снаружи (карту сдвинули) — без повтора', async () => {
    let n = 0;
    vi.stubGlobal('fetch', (u: string, init?: { signal?: AbortSignal }) => { n++; return hang(u, init); });
    const ac = new AbortController();
    const p = fetchBuffer('https://x/4.png', ac.signal);
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(n).toBe(1);
  });
});
