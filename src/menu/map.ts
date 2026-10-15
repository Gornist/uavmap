// Меню → «Карта»: подложка, затемнение, отмывка, горизонтали, подписи и дороги.
import { S, BASES, SOFT_GL, applyMapStyle } from '../app';
import { h, field, button } from '../ui';
import { applyContours } from '../contours';
import { render, section } from './common';

export function mapSection(el: HTMLElement) {
  section(el, 'Подложка');
  const seg = h('<div class="seg seg-wrap"></div>');
  for (const [id, b] of Object.entries(BASES)) {
    seg.appendChild(button(b.name, id === S.map.base ? 'on' : '', () => { S.map.base = id; applyMapStyle(); render(); }));
  }
  el.appendChild(seg);
  const dim = field('Затемнение', '<input type="range" min="0" max="0.8" step="0.05">');
  const di = dim.querySelector('input') as HTMLInputElement;
  di.value = String(S.map.dim);
  di.addEventListener('input', () => { S.map.dim = Math.min(0.8, Math.max(0, +di.value)); applyMapStyle(); });
  el.appendChild(dim);

  section(el, 'Поверх карты');
  const chk = (label: string, hint: string, key: 'hillshade' | 'contours' | 'labels') => {
    const c = h('<label class="chk"><input type="checkbox"><span><span class="chk-t"></span><small class="muted"></small></span></label>');
    c.querySelector('.chk-t')!.textContent = label;
    c.querySelector('small')!.textContent = hint;
    const i = c.querySelector('input') as HTMLInputElement;
    i.checked = S.map[key];
    i.addEventListener('change', () => { S.map[key] = i.checked; applyMapStyle(); applyContours(); });
    el.appendChild(c);
  };
  chk('Подписи и дороги', 'названия, дороги, грунтовки, вершины, границы', 'labels');
  chk('Горизонтали', 'линии равной высоты', 'contours');
  chk('Отмывка рельефа', SOFT_GL ? 'тени склонов; в этом браузере нет ускорения графики — карта с ней медленнее' : 'тени склонов', 'hillshade');
  el.appendChild(h('<p class="hint muted">Без сети подложка не загрузится — сохраняется только рельеф (раздел «Офлайн»).</p>'));
}
