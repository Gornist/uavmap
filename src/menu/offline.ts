// Меню → «Офлайн»: офлайн-районы рельефа и свои карты (шторки — в src/offline.ts и src/mymaps.ts).
import { h, button } from '../ui';
import { openOfflineSheet, offlineAreaCount } from '../offline';
import { openMyMapsSheet, myMapsCount } from '../mymaps';
import { close, section } from './common';

export function offlineSection(el: HTMLElement) {
  section(el, 'Офлайн-районы');
  el.appendChild(h('<p class="hint">Скачайте рельеф района заранее — связь, профиль и зона будут считаться без сети.</p>'));
  const n = offlineAreaCount();
  el.appendChild(button(n ? `Офлайн-районы (${n})…` : 'Скачать район…', 'primary', () => { close(); openOfflineSheet(); }));
  el.appendChild(h('<p class="hint warn-line"><b>Подложка офлайн не сохраняется</b> — только рельеф и свои карты. Без сети спутник и топокарта не покажутся.</p>'));

  section(el, 'Свои карты');
  el.appendChild(h('<p class="hint">Своя подложка из файла PMTiles и свой рельеф HGT — работают без сети.</p>'));
  const m = myMapsCount();
  el.appendChild(button(m ? `Свои карты (${m})…` : 'Добавить свою карту…', 'ghost', () => { close(); openMyMapsSheet(); }));
}
