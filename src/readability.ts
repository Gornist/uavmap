// Читаемость в поле: «Яркое солнце» (непрозрачные плашки под всем текстом поверх карты, жирные обводки)
// и «Крупный текст». Настройки устройства, а не проекта (как и тема): в копию проекта не попадают.
// Ставятся классами на <html>: sun, big-text (стили — styles/live.css).
export type ReadOpt = 'sun' | 'big-text';
const KEY: Record<ReadOpt, string> = { sun: 'uavmap.ui.sun', 'big-text': 'uavmap.ui.big' };

const read = (o: ReadOpt) => { try { return localStorage.getItem(KEY[o]) === '1'; } catch { return false; } };

export const readOpt = (o: ReadOpt): boolean => document.documentElement.classList.contains(o);

export function setReadOpt(o: ReadOpt, on: boolean): void {
  document.documentElement.classList.toggle(o, on);
  try { localStorage.setItem(KEY[o], on ? '1' : '0'); } catch { /* нет места — до перезапуска */ }
  window.dispatchEvent(new Event('uavmap:readability'));
}

export function initReadability(): void {
  for (const o of Object.keys(KEY) as ReadOpt[]) document.documentElement.classList.toggle(o, read(o));
}
