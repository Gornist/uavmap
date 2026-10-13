// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { dialog, confirmDialog, promptDialog, coordsBlock } from './ui';

const scrim = () => document.querySelector('.dlg-scrim') as HTMLElement | null;
const btn = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => b.textContent === text)!;
const key = (target: EventTarget, k: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

afterEach(() => { document.body.innerHTML = ''; });

describe('dialog', () => {
  it('подтверждение: кнопка → true, разметка убирается, текст — как текст', async () => {
    const p = confirmDialog('Удалить?', '<b>x</b>', 'Удалить');
    expect(scrim()).not.toBeNull();
    expect(document.querySelector('.dlg')!.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('.dlg-text')!.textContent).toBe('<b>x</b>');
    expect(document.querySelector('.dlg-text b')).toBeNull();
    btn('Удалить').click();
    await expect(p).resolves.toBe(true);
    expect(scrim()).toBeNull();
  });

  it('необратимое действие: фокус на «Отмена», «Отмена» → false', async () => {
    const p = confirmDialog('Сбросить?', 'Всё удалится', 'Сбросить');
    expect(document.activeElement).toBe(btn('Отмена'));
    btn('Отмена').click();
    await expect(p).resolves.toBe(false);
  });

  it('Escape отменяет и не доходит до обработчиков документа (меню, шторка)', async () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const p = dialog({ title: 'T', buttons: [{ text: 'OK', value: 1 }] });
    key(document.activeElement ?? document.body, 'Escape');
    await expect(p).resolves.toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
    // После закрытия клавиши снова идут как обычно.
    const after = vi.fn();
    document.addEventListener('keydown', after);
    key(document.body, 'Escape');
    expect(after).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', after);
  });

  it('ввод: фокус в поле, Enter нажимает главную кнопку, значение обрезается', async () => {
    const p = promptDialog('Название', 'Маршрут 1');
    const inp = document.querySelector('.dlg input') as HTMLInputElement;
    expect(document.activeElement).toBe(inp);
    expect(inp.value).toBe('Маршрут 1');
    expect(inp.maxLength).toBe(120);
    inp.value = '  Северный  ';
    key(inp, 'Enter');
    await expect(p).resolves.toBe('Северный');
  });

  it('выбор из нескольких кнопок: значение выбранной, Enter — кнопка def', async () => {
    const p = dialog({ title: 'Формат', input: { value: '' }, buttons: [{ text: 'GeoJSON', value: 'geojson', def: true }, { text: 'GPX', value: 'gpx' }] });
    expect(btn('GeoJSON').className).toBe('primary');
    expect(btn('GPX').className).toBe('ghost');
    key(document.querySelector('.dlg input')!, 'Enter');
    await expect(p).resolves.toEqual({ value: 'geojson', input: '' });
    const p2 = dialog({ title: 'Формат', buttons: [{ text: 'GeoJSON', value: 'geojson' }, { text: 'GPX', value: 'gpx' }] });
    btn('GPX').click();
    await expect(p2).resolves.toEqual({ value: 'gpx', input: '' });
  });

  it('клик мимо окна отменяет; клик по окну — нет', async () => {
    const p = dialog({ title: 'T', buttons: [{ text: 'OK', value: 1 }] });
    document.querySelector('.dlg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(scrim()).not.toBeNull();
    scrim()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it('Tab не выпускает фокус из диалога', async () => {
    const p = dialog({ title: 'T', buttons: [{ text: 'A', value: 1 }, { text: 'B', value: 2 }] });
    const bs = [...document.querySelectorAll<HTMLButtonElement>('.dlg button')]; // Отмена, A, B
    bs[2].focus();
    key(bs[2], 'Tab');
    expect(document.activeElement).toBe(bs[0]);
    key(bs[0], 'Tab', true);
    expect(document.activeElement).toBe(bs[2]);
    bs[0].click();
    await p;
  });

  it('второй диалог отменяет первый; фокус возвращается на прежний элемент', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const p1 = dialog({ title: '1', buttons: [{ text: 'OK', value: 1 }] });
    const p2 = dialog({ title: '2', buttons: [{ text: 'OK', value: 2 }] });
    await expect(p1).resolves.toBeNull();
    expect(document.querySelectorAll('.dlg-scrim').length).toBe(1);
    btn('OK').click();
    await expect(p2).resolves.toEqual({ value: 2, input: '' });
    expect(document.activeElement).toBe(opener);
  });

  it('кнопки диалога не отправляют формы (type=button), класс главной кнопки задаётся', async () => {
    const p = confirmDialog('T', 't', 'Да', 'primary');
    for (const b of document.querySelectorAll('.dlg-acts button')) expect(b.getAttribute('type')).toBe('button');
    btn('Да').click();
    await expect(p).resolves.toBe(true);
  });
});

describe('coordsBlock', () => {
  it('выбранный формат крупно, остальные два — в свёрнутом «Другие форматы»', () => {
    const el = coordsBlock(55.75, 37.62, 'dd');
    expect(el.querySelector('.coords-main small')!.textContent).toBe('WGS-84');
    expect(el.querySelector('.coords-main .mono')!.textContent).toContain('55.750000');
    const d = el.querySelector('details') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')!.textContent).toBe('Другие форматы');
    const labels = [...d.querySelectorAll('small')].map((s) => s.textContent);
    expect(labels).toEqual(['СК-42', 'WGS-84, Г°М′С″']);
  });
});
