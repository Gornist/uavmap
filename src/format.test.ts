import { describe, expect, it } from 'vitest';
import { km, dB, fmtBytes, fixed, escapeHtml } from './format';

describe('km: единый формат «1,6 км»', () => {
  it('до 1 км — целые метры', () => {
    expect(km(0)).toBe('0 м');
    expect(km(999.4)).toBe('999 м');
  });
  it('до 100 км — один знак после запятой, дальше — целые', () => {
    expect(km(1000)).toBe('1,0 км');
    expect(km(1550)).toBe('1,6 км');
    expect(km(12345)).toBe('12,3 км');
    expect(km(99940)).toBe('99,9 км');
    expect(km(100000)).toBe('100 км');
    expect(km(634000)).toBe('634 км');
  });
  it('не число — прочерк', () => {
    expect(km(NaN)).toBe('—');
    expect(km(Infinity)).toBe('—');
  });
});

describe('dB', () => {
  it('целые со знаком, минус — «−»', () => {
    expect(dB(17.4)).toBe('+17 дБ');
    expect(dB(-2.6)).toBe('−3 дБ');
    expect(dB(0)).toBe('+0 дБ');
    expect(dB(-0.4)).toBe('+0 дБ');
  });
});

describe('fmtBytes', () => {
  it('КБ целыми (не меньше 1), МБ и ГБ с запятой', () => {
    expect(fmtBytes(10)).toBe('1 КБ');
    expect(fmtBytes(90 * 1024)).toBe('90 КБ');
    expect(fmtBytes(1.5 * 1024 ** 2)).toBe('1,5 МБ');
    expect(fmtBytes(150 * 1024 ** 2)).toBe('150 МБ');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3,0 ГБ');
  });
});

describe('fixed и escapeHtml', () => {
  it('десятичная запятая', () => expect(fixed(1.333, 2)).toBe('1,33'));
  it('экранирует разметку и кавычки', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&#60;img src=x onerror=&#34;a(&#39;b&#39;)&#34;&#62;&#38;');
  });
});
