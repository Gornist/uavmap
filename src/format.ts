// Единый формат чисел интерфейса: десятичная запятая («1,6 км»), минус — «−». Чистые функции без DOM.

/** Число с d знаками после запятой: fixed(1.25, 1) → «1,3». */
export const fixed = (x: number, d: number) => x.toFixed(d).replace('.', ',');

/** Дальность: до 1 км — целые метры, до 100 км — км с одним знаком, дальше — целые км. */
export function km(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} м`;
  return `${fixed(m / 1000, m < 100000 ? 1 : 0)} км`;
}

/** дБ целыми со знаком: «+17 дБ», «−3 дБ». */
export function dB(x: number): string {
  const r = Math.round(x);
  return `${r >= 0 ? '+' : '−'}${Math.abs(r)} дБ`;
}

/** Объём: КБ целыми, МБ и ГБ с одним знаком (от 100 МБ — целыми). */
export function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${fixed(b / 1024 ** 3, 1)} ГБ`;
  if (b >= 1024 ** 2) return `${fixed(b / 1024 ** 2, b >= 100 * 1024 ** 2 ? 0 : 1)} МБ`;
  return `${Math.max(1, Math.round(b / 1024))} КБ`;
}

/** Текст для вставки в HTML: экранирует < > & " '. */
export const escapeHtml = (t: string) => t.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
