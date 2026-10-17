// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initReadability, setReadOpt, readOpt } from './readability';

const html = () => document.documentElement.classList;

/** Хранилище настроек устройства — своя заглушка (у среды теста localStorage может не быть). */
let store: Map<string, string>;
const fakeStorage = () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
});

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', fakeStorage());
  html().remove('sun', 'big-text');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('читаемость: «Яркое солнце» и «Крупный текст»', () => {
  it('по умолчанию выключены', () => {
    initReadability();
    expect(html().contains('sun')).toBe(false);
    expect(html().contains('big-text')).toBe(false);
    expect(readOpt('sun')).toBe(false);
  });
  it('setReadOpt: класс на <html>, запись в localStorage и событие для подписчиков', () => {
    const ev = vi.fn();
    window.addEventListener('uavmap:readability', ev);
    setReadOpt('sun', true);
    expect(html().contains('sun')).toBe(true);
    expect(readOpt('sun')).toBe(true);
    expect(store.get('uavmap.ui.sun')).toBe('1');
    setReadOpt('big-text', true);
    expect(html().contains('big-text')).toBe(true);
    expect(store.get('uavmap.ui.big')).toBe('1');
    setReadOpt('sun', false);
    expect(html().contains('sun')).toBe(false);
    expect(html().contains('big-text')).toBe(true); // настройки независимы
    expect(store.get('uavmap.ui.sun')).toBe('0');
    expect(ev).toHaveBeenCalledTimes(3);
    window.removeEventListener('uavmap:readability', ev);
  });
  it('initReadability восстанавливает сохранённое (после перезапуска классов нет)', () => {
    store.set('uavmap.ui.big', '1');
    store.set('uavmap.ui.sun', '0');
    html().add('sun'); // чужой класс от прошлого состояния — снимается
    initReadability();
    expect(html().contains('big-text')).toBe(true);
    expect(html().contains('sun')).toBe(false);
  });
  it('localStorage недоступен (приватный режим, запрет): чтение — выключено, запись — без исключения', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    });
    expect(() => initReadability()).not.toThrow();
    expect(html().contains('sun')).toBe(false);
    expect(() => setReadOpt('sun', true)).not.toThrow();
    expect(html().contains('sun')).toBe(true); // до перезапуска действует
  });
  it('localStorage отсутствует совсем', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => initReadability()).not.toThrow();
    expect(() => setReadOpt('big-text', true)).not.toThrow();
    expect(html().contains('big-text')).toBe(true);
  });
});
