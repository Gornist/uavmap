// Меню → «Инструменты»: линейка (включить/выключить) и список маршрутов (показать, переименовать, удалить).
import { S, map, emit } from '../app';
import { h, button, promptDialog, confirmDialog } from '../ui';
import { km } from '../format';
import { distance } from '../geo';
import { toggleRuler, rulerActive } from '../ruler';
import { close, render, section } from './common';

const routeLen = (pts: [number, number][]) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += distance({ lon: pts[i - 1][0], lat: pts[i - 1][1] }, { lon: pts[i][0], lat: pts[i][1] });
  return len;
};

export function tools(el: HTMLElement) {
  section(el, 'Линейка');
  const on = rulerActive();
  el.appendChild(h(`<p class="hint">${on
    ? 'Линейка включена: панель внизу карты.'
    : 'Измерить расстояние и азимут по точкам. Отрезки можно сохранить как маршрут.'}</p>`));
  el.appendChild(button(on ? 'Выключить линейку' : '📏 Включить линейку', on ? 'ghost on' : 'primary', () => {
    toggleRuler();
    if (rulerActive()) close(); else render();
  }));

  section(el, `Маршруты (${S.routes.length})`);
  if (!S.routes.length) el.appendChild(h('<p class="hint">Маршрутов нет. Нарисуйте линейкой и нажмите «Сохранить маршрут» или импортируйте файл.</p>'));
  const rl = h('<div class="list"></div>');
  for (const r of S.routes) {
    const li = h('<div class="li li-acts"><button class="li-main" type="button"><span class="t"></span><small></small></button><button class="mini" type="button" title="Переименовать" aria-label="Переименовать">✎</button><button class="mini" type="button" title="Удалить" aria-label="Удалить">🗑</button></div>');
    li.querySelector('.t')!.textContent = r.name || 'Маршрут';
    li.querySelector('small')!.textContent = km(routeLen(r.pts));
    const [show, ren, del] = li.querySelectorAll('button');
    show.addEventListener('click', () => {
      if (!r.pts.length) return;
      // Экстремумы циклом: spread по сотням тысяч точек превышает предел аргументов.
      let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
      for (const [lon, lat] of r.pts) { w = Math.min(w, lon); e = Math.max(e, lon); so = Math.min(so, lat); no = Math.max(no, lat); }
      close();
      map.fitBounds([[w, so], [e, no]], { padding: 60, maxZoom: 16 });
    });
    ren.addEventListener('click', async () => {
      const n = await promptDialog('Название маршрута', r.name);
      if (n === null || !n) return;
      r.name = n.slice(0, 120); emit('routes');
    });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('Удалить маршрут?', `«${r.name || 'Маршрут'}» исчезнет с карты.`, 'Удалить'))) return;
      S.routes = S.routes.filter((x) => x.id !== r.id); emit('routes');
    });
    rl.appendChild(li);
  }
  el.appendChild(rl);
}
