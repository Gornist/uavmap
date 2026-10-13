// Меню: общее для разделов — закрыть ящик, перерисовать раздел, «тихий» emit, заголовок и разбор числа.
// Разделы не импортируют index.ts (без циклов): перерисовку index регистрирует здесь.
import { $, emit } from '../app';
import { h } from '../ui';

/** Свои правки не должны перерисовывать раздел (теряется фокус поля). */
export let quiet = false;
let renderFn: () => void = () => undefined;

export const isOpen = () => document.body.classList.contains('drawer-open');

export function close() {
  document.body.classList.remove('drawer-open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

/** emit без перерисовки открытого раздела. */
export function fire(e: Parameters<typeof emit>[0]) {
  quiet = true;
  try { emit(e); } finally { quiet = false; }
}

/** Перерисовать открытый раздел меню. */
export const render = () => renderFn();
export const setRender = (f: () => void) => { renderFn = f; };

export const section = (el: HTMLElement, title: string) => { const t = h('<h4></h4>'); t.textContent = title; el.appendChild(t); };
export const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));
