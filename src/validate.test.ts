import { describe, expect, it } from 'vitest';
import { isObj, num, inRange, fin, oneOf } from './validate';

describe('validate', () => {
  it('isObj: только обычные объекты', () => {
    expect(isObj({})).toBe(true);
    for (const v of [null, undefined, [], 1, 'x', true]) expect(isObj(v)).toBe(false);
  });
  it('num: конечное число или NaN', () => {
    expect(num(5)).toBe(5);
    for (const v of ['5', NaN, Infinity, null, {}]) expect(num(v)).toBeNaN();
  });
  it('inRange и fin: границы включены, нечисла и NaN отбрасываются', () => {
    expect(inRange(0, 0, 10)).toBe(true);
    expect(inRange(10, 0, 10)).toBe(true);
    expect(inRange(10.01, 0, 10)).toBe(false);
    expect(inRange('5', 0, 10)).toBe(false);
    expect(inRange(NaN, -Infinity, Infinity)).toBe(false);
    expect(fin(7, 0, 10, 3)).toBe(7);
    expect(fin(70, 0, 10, 3)).toBe(3);
    expect(fin(undefined, 0, 10, 3)).toBe(3);
  });
  it('oneOf: значение из списка или запасное', () => {
    const modes = ['takeoff', 'terrain'] as const;
    expect(oneOf('terrain', modes, 'takeoff')).toBe('terrain');
    expect(oneOf('sea', modes, 'takeoff')).toBe('takeoff');
    expect(oneOf(1, modes, 'takeoff')).toBe('takeoff');
  });
});
