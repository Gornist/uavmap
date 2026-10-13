// Проверка недоверенных данных (localStorage, импортируемые файлы): только типы и диапазоны, без DOM.

/** Обычный объект (не массив и не null). */
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Конечное число или NaN. */
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Конечное число в [lo, hi]. */
export const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Число в [lo, hi], иначе def. */
export const fin = (v: unknown, lo: number, hi: number, def: number) => (inRange(v, lo, hi) ? v : def);

/** Одно из допустимых значений, иначе def. */
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
