// Мелкие элементы интерфейса: общие кнопки, чипы, поля, раскрывающиеся блоки, координаты, диалоги.
// Текст из данных передавать только через textContent (параметры text/title ниже).
import { formatCoords, type CoordFormat } from './coords';

/** Элемент из HTML-строки (только разметка из кода, не данные пользователя). */
export const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

/** Кнопка с текстом и обработчиком. */
export function button(text: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

/** Ряд чипов-переключателей; on — выбранный. */
export function chips(items: { text: string; on?: boolean; click: () => void; cls?: string }[]): HTMLElement {
  const box = h('<div class="chips"></div>');
  for (const it of items) box.appendChild(button(it.text, [it.on ? 'on' : '', it.cls ?? ''].filter(Boolean).join(' '), it.click));
  return box;
}

/** Поле с подписью: label — статичная разметка из кода, input — HTML поля. */
export const field = (label: string, input: string) => h(`<label class="field"><span>${label}</span>${input}</label>`);

/** Раскрывающийся блок «Подробнее»; onToggle — запомнить состояние между перерисовками. */
export function details(title: string, isOpen: boolean, onToggle?: (open: boolean) => void): HTMLDetailsElement {
  const el = document.createElement('details');
  el.className = 'details';
  el.open = isOpen;
  const s = document.createElement('summary');
  s.textContent = title;
  el.appendChild(s);
  if (onToggle) el.addEventListener('toggle', () => onToggle(el.open));
  return el;
}

const COORD_FORMATS: CoordFormat[] = ['sk42', 'dd', 'dms'];

/** Координаты для карточек: выбранный формат крупно, остальные — в свёрнутом «Другие форматы». */
export function coordsBlock(lat: number, lon: number, fmt: CoordFormat): HTMLElement {
  const box = h('<div class="coords"></div>');
  const main = formatCoords(lat, lon, fmt);
  const big = h('<div class="coords-main"><small></small><div class="mono"></div></div>');
  big.querySelector('small')!.textContent = main.label;
  // rows — цифры из formatCoords (разметка из кода: <em> для выделения километров), не данные пользователя.
  big.querySelector('.mono')!.innerHTML = main.rows.map(([k, v]) => `<div><span class="k">${k}</span> ${v}</div>`).join('');
  box.appendChild(big);
  const more = details('Другие форматы', false);
  const kv = h('<div class="kv"></div>');
  for (const f of COORD_FORMATS) {
    if (f === fmt) continue;
    const c = formatCoords(lat, lon, f);
    const d = h('<div><small></small><b class="mono"></b></div>');
    d.querySelector('small')!.textContent = f === 'dms' ? `${c.label}, Г°М′С″` : f === 'dd' ? `${c.label}, градусы` : c.label;
    d.querySelector('b')!.innerHTML = c.short;
    kv.appendChild(d);
  }
  more.appendChild(kv);
  box.appendChild(more);
  return box;
}

// ---------- Диалоги (вместо prompt/confirm) ----------

export interface DialogButton<T> { text: string; value: T; cls?: string }
export interface DialogOptions<T> {
  title: string;
  text?: string;
  /** Поле ввода: начальное значение, подсказка, предел длины. */
  input?: { value?: string; placeholder?: string; maxLength?: number; label?: string; inputMode?: string };
  /** Кнопки слева направо; Enter нажимает кнопку с def: true (или последнюю). Отмена — Escape, клик мимо, «Отмена». */
  buttons: (DialogButton<T> & { def?: boolean })[];
  /** Подпись кнопки отмены; пустая строка — без кнопки (Escape всё равно отменяет). */
  cancel?: string;
}
export interface DialogResult<T> { value: T; input: string }

let closeOpen: (() => void) | null = null;

/** Модальный диалог. Промис: выбранная кнопка и текст поля или null при отмене. */
export function dialog<T>(o: DialogOptions<T>): Promise<DialogResult<T> | null> {
  closeOpen?.(); // одновременно — только один диалог
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    const scrim = h('<div class="dlg-scrim"><div class="dlg" role="dialog" aria-modal="true"><h3 class="dlg-title"></h3></div></div>');
    const box = scrim.firstElementChild as HTMLElement;
    const tid = `dlg${Date.now().toString(36)}`;
    const title = box.querySelector('h3')!;
    title.id = tid; title.textContent = o.title;
    box.setAttribute('aria-labelledby', tid);
    if (o.text) { const p = h('<p class="dlg-text"></p>'); p.textContent = o.text; box.appendChild(p); }
    let inp: HTMLInputElement | null = null;
    if (o.input) {
      const lab = h('<label class="dlg-field"><span></span><input type="text"></label>');
      lab.querySelector('span')!.textContent = o.input.label ?? '';
      if (!o.input.label) lab.querySelector('span')!.remove();
      inp = lab.querySelector('input')!;
      inp.value = o.input.value ?? '';
      if (o.input.placeholder) inp.placeholder = o.input.placeholder;
      if (o.input.maxLength) inp.maxLength = o.input.maxLength;
      if (o.input.inputMode) inp.setAttribute('inputmode', o.input.inputMode); // цифровая клавиатура на телефоне
      box.appendChild(lab);
    }
    const acts = h('<div class="dlg-acts"></div>');
    let done = false;
    const finish = (r: DialogResult<T> | null) => {
      if (done) return;
      done = true;
      closeOpen = null;
      window.removeEventListener('keydown', onKey, true);
      scrim.remove();
      if (prev && prev.isConnected) prev.focus();
      resolve(r);
    };
    closeOpen = () => finish(null);
    const cancelText = o.cancel ?? 'Отмена';
    const cancelBtn = cancelText ? button(cancelText, 'ghost', () => finish(null)) : null;
    if (cancelBtn) acts.appendChild(cancelBtn);
    const di = o.buttons.findIndex((b) => b.def);
    const defIdx = di >= 0 ? di : o.buttons.length - 1;
    const btns = o.buttons.map((b, i) => button(b.text, b.cls ?? (i === defIdx ? 'primary' : 'ghost'), () => finish({ value: b.value, input: inp?.value ?? '' })));
    for (const el of btns) acts.appendChild(el);
    const defBtn = btns[defIdx] ?? null;
    box.appendChild(acts);

    scrim.addEventListener('click', (e) => { if (e.target === scrim) finish(null); });
    // Клавиши ловим на window в фазе перехвата: Escape не должен закрыть ещё и меню или шторку под диалогом,
    // даже если фокус ушёл с элементов диалога. Остальные клавиши идут как обычно (ввод в поле).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
      if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); e.stopPropagation(); defBtn?.click(); return; }
      if (e.key === 'Tab') {
        // Фокус не уходит за пределы диалога.
        e.preventDefault(); e.stopPropagation();
        const f = [...box.querySelectorAll<HTMLElement>('input, button')];
        const i = f.indexOf(document.activeElement as HTMLElement);
        const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 || i < 0 ? 0 : i + 1);
        f[n]?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    // Фокус: поле ввода; иначе главная кнопка, но для необратимого действия — «Отмена» (случайный Enter ничего не удалит).
    if (inp) { inp.focus(); inp.select(); } else if (defBtn?.classList.contains('danger') && cancelBtn) cancelBtn.focus(); else (defBtn ?? cancelBtn)?.focus();
  });
}

/** Подтверждение: true — согласились. okCls 'danger' — для необратимых действий. */
export async function confirmDialog(title: string, text: string, ok: string, okCls = 'danger'): Promise<boolean> {
  return (await dialog({ title, text, buttons: [{ text: ok, value: true, cls: okCls }] })) !== null;
}

/** Ввод строки: новое значение (обрезанное) или null при отмене. */
export async function promptDialog(title: string, value: string, ok = 'Сохранить', maxLength = 120): Promise<string | null> {
  const r = await dialog({ title, input: { value, maxLength }, buttons: [{ text: ok, value: true }] });
  return r ? r.input.trim() : null;
}
