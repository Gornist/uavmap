import { describe, expect, it } from 'vitest';
import { heightHint, hereText } from './verdict';

describe('heightHint: одна подсказка-действие по высоте дрона', () => {
  it('управление не добьёт ни с какой высоты / на грани на любой высоте', () => {
    expect(heightHint(300, { rc: null, video: null, pair: null })).toBe('Управление не добьёт даже на 1500 м — подойдите ближе или нажмите «Где встать»');
    expect(heightHint(300, { rc: null, video: null, pair: null }, 'Видео', { rc: 'weak', video: 'none' })).toBe('Даже на 1500 м управление на грани — подойдите ближе');
  });
  it('одна линия: поднять или можно снизиться', () => {
    expect(heightHint(100, { rc: 210, pair: 210 })).toBe('Поднимите до 210 м — появится связь');
    expect(heightHint(300, { rc: 210, pair: 210 })).toBe('Связь держится; можно снизиться до 210 м');
    expect(heightHint(210, { rc: 210, pair: 210 })).toBe('Связь держится');
    expect(heightHint(50, { rc: 0, pair: 0 })).toBe('Связь держится на любой высоте');
  });
  it('две линии: сначала управление, потом видео', () => {
    expect(heightHint(100, { rc: 210, video: 480, pair: 480 }, 'Видео 5,8 ГГц'))
      .toBe('Поднимите до 210 м — появится управление, до 480 м — и видео');
    expect(heightHint(300, { rc: 210, video: 480, pair: 480 })).toBe('Поднимите до 480 м — будет и видео');
    expect(heightHint(600, { rc: 210, video: 480, pair: 480 })).toBe('Управление и видео держатся; можно снизиться до 480 м');
    expect(heightHint(100, { rc: 210, video: 150, pair: 210 })).toBe('Поднимите до 210 м — появится связь');
  });
  it('видео не добьёт: говорим прямо, без числа для видео', () => {
    expect(heightHint(300, { rc: 210, video: null, pair: null }, 'Видео 5,8 ГГц')).toBe('Видео 5,8 ГГц не добьёт даже на 1500 м — подойдите ближе');
    expect(heightHint(100, { rc: 210, video: null, pair: null }, 'Видео 5,8 ГГц')).toBe('Поднимите до 210 м — появится управление; видео 5,8 ГГц не добьёт даже на 1500 м');
  });
  it('видео на грани до предела поиска: «на грани», а не «не добьёт»', () => {
    const n = { rc: 210, video: null, pair: null };
    expect(heightHint(300, n, 'Видео 5,8 ГГц', { rc: 'ok', video: 'weak' })).toBe('Видео 5,8 ГГц на грани даже на 1500 м — подойдите ближе');
    expect(heightHint(100, n, 'Видео 5,8 ГГц', { rc: 'none', video: 'weak' })).toBe('Поднимите до 210 м — появится управление; видео 5,8 ГГц на грани даже на 1500 м');
  });
  it('выше предела поиска связь есть — не пишем «не добьёт»', () => {
    expect(heightHint(2000, { rc: null, video: null, pair: null }, 'Видео', { rc: 'ok', video: 'ok' })).toBe('Управление и видео держатся');
    expect(heightHint(2000, { rc: null, pair: null }, 'Видео', { rc: 'ok' })).toBe('Связь держится');
    expect(heightHint(2000, { rc: 900, video: null, pair: null }, 'Видео', { rc: 'ok', video: 'ok' })).toBe('Управление и видео держатся');
  });
});

describe('hereText: высота под прицелом словами', () => {
  it('без пульта — над уровнем моря', () => {
    expect(hereText(914.4, null, false)).toBe('Рельеф 914 м');
    expect(hereText(914, 552, false)).toBe('Рельеф 914 м');
  });
  it('с пультом — относительно него', () => {
    expect(hereText(914, 552, true)).toBe('На 362 м выше пульта');
    expect(hereText(430, 552, true)).toBe('На 122 м ниже пульта');
    expect(hereText(553, 552, true)).toBe('Вровень с пультом');
  });
  it('высота пульта ещё не загружена или нет рельефа', () => {
    expect(hereText(914, null, true)).toBe('Рельеф 914 м');
    expect(hereText(null, 552, true)).toBe('Нет данных рельефа');
  });
});
