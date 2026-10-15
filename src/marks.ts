// Метки на карте.
// Данные — S.marks; после изменений emit('marks'). Текст из импорта выводить только как текст (escapeHtml).
import maplibregl from 'maplibre-gl';
import { S, map, center, toast, openSheet, closeSheet, emit, on } from './app';
import { h, coordsBlock, confirmDialog } from './ui';
import { setStation } from './station';
import { showProfile } from './lazy';
import { elevationAt } from './elevation';
import type { LatLon } from './geo';
import { uid, MARK_COLOR } from './store';
import type { Mark } from './store';

const COLORS = [MARK_COLOR, '#e5484d', '#4fbf72', '#4aa3ff', '#b57cf0', '#ffffff'];
const markers = new Map<string, { m: maplibregl.Marker; el: HTMLElement; flag: HTMLElement; label: HTMLElement }>();

function sync() {
  const ids = new Set(S.marks.map((m) => m.id));
  for (const [id, v] of markers) if (!ids.has(id)) { v.m.remove(); markers.delete(id); }
  for (const mk of S.marks) {
    let v = markers.get(mk.id);
    if (!v) {
      const flag = document.createElement('span');
      flag.textContent = '⚑';
      const label = document.createElement('span');
      label.className = 'mk-label';
      const el = document.createElement('div');
      el.className = 'mk';
      el.append(flag, label);
      el.addEventListener('click', (e) => { e.stopPropagation(); openMark(mk.id); });
      v = { m: new maplibregl.Marker({ element: el }).setLngLat([mk.lon, mk.lat]).addTo(map), el, flag, label };
      markers.set(mk.id, v);
    }
    v.m.setLngLat([mk.lon, mk.lat]);
    v.flag.style.color = mk.color;
    v.label.textContent = mk.name;
  }
}

/** Отрисовать метки из S.marks и подписаться на 'marks'. */
export function initMarks(): void {
  sync();
  on('marks', sync);
}

/** Новая метка в точке p (по умолчанию — прицел), сразу открыть её карточку. */
export function addMarkAt(p: LatLon = center()): void {
  const mk: Mark = { id: uid(), name: `Метка ${S.marks.length + 1}`, note: '', lat: p.lat, lon: p.lon, color: COLORS[0], folder: '', created: Date.now() };
  S.marks.push(mk);
  emit('marks');
  openMark(mk.id);
}

/** Новая метка в прицеле (кнопка «Метка» внизу). */
export const addMarkAtCenter = (): void => addMarkAt();

/** Карточка метки: имя, заметка, цвет, рельеф, координаты, «Пульт сюда», «Профиль сюда», удалить. */
export function openMark(id: string): void {
  const mk = S.marks.find((m) => m.id === id);
  if (!mk) return;
  const body = h('<div class="card-sheet"></div>');
  body.innerHTML = `
    <label class="field col"><span>Название</span><input class="txt" id="mkName" maxlength="120"/></label>
    <label class="field col"><span>Заметка</span><textarea class="txt" id="mkNote" maxlength="1000"></textarea></label>
    <div class="colors" id="mkColors"></div>
    <div class="kv"><div><small>Рельеф</small><b id="mkH">…</b></div></div>
    <div id="mkCoords"></div>
    <div class="row"><button class="ghost" id="mkSt">Пульт сюда</button><button class="ghost" id="mkProf">Профиль сюда</button><button class="danger" id="mkDel">Удалить метку</button></div>`;
  const q = <T extends HTMLElement>(s: string) => body.querySelector(s) as T;
  const name = q<HTMLInputElement>('#mkName'), note = q<HTMLTextAreaElement>('#mkNote');
  name.value = mk.name; note.value = mk.note;
  name.addEventListener('input', () => { mk.name = name.value; emit('marks'); });
  note.addEventListener('input', () => { mk.note = note.value; emit('marks'); });

  const colors = q('#mkColors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = 'Цвет метки';
    b.setAttribute('aria-label', 'Цвет метки');
    b.classList.toggle('on', c === mk.color);
    b.addEventListener('click', () => {
      mk.color = c; emit('marks');
      colors.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
    colors.appendChild(b);
  }

  q('#mkCoords').appendChild(coordsBlock(mk.lat, mk.lon, S.coordFormat));

  const target = { lat: mk.lat, lon: mk.lon };
  elevationAt(target).then((e) => { if (body.isConnected) q('#mkH').textContent = e === null ? '—' : `${Math.round(e)} м`; });

  q('#mkSt').addEventListener('click', () => { setStation(target); toast('Пульт поставлен на метку'); });
  q('#mkProf').addEventListener('click', () => { map.flyTo({ center: [mk.lon, mk.lat] }); showProfile(target); });
  q('#mkDel').addEventListener('click', async () => {
    if (!(await confirmDialog('Удалить метку?', `«${mk.name || 'Метка'}» исчезнет с карты.`, 'Удалить'))) return;
    S.marks = S.marks.filter((m) => m.id !== id);
    emit('marks');
    closeSheet();
  });
  openSheet('⚑ Метка', body);
}
