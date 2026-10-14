// Шторка «Точка»: рельеф (над морем и относительно пульта) и координаты места, расстояние от пульта, «Пульт сюда», «Метка сюда», «Профиль сюда», копирование.
import maplibregl from 'maplibre-gl';
import { S, map, center, toast, openSheet, closeSheet } from './app';
import { h, coordsBlock } from './ui';
import { km } from './format';
import { formatCoords } from './coords';
import { elevationAt } from './elevation';
import { distance, bearing, type LatLon } from './geo';
import { setStation, stationGround } from './station';
import { hereText } from './verdict';
import { showProfile } from './profileSheet';
import { addMarkAt } from './marks';

let pointPin: maplibregl.Marker | null = null;
const clearPin = () => { pointPin?.remove(); pointPin = null; };

/** Шторка «Точка»: для прицела или (долгое нажатие / правый клик) для места нажатия. */
export function openPointSheet(at?: LatLon) {
  const p = at ?? center();
  const body = h('<div class="card-sheet"></div>');
  let kv = '<div class="kv"><div><small>Рельеф над морем</small><b id="ptH">…</b></div>';
  if (S.station) {
    const a = { lat: S.station.lat, lon: S.station.lon };
    kv += '<div><small>Относительно пульта</small><b id="ptRel">…</b></div>';
    kv += `<div><small>От пульта</small><b>${km(distance(a, p))}, азимут ${Math.round(bearing(a, p)) % 360}°</b></div>`;
  }
  body.innerHTML = `${kv}</div><div id="ptCoords"></div>
    <div class="row"><button class="ghost" id="ptSt">Пульт сюда</button><button class="ghost" id="ptMk">Метка сюда</button><button class="ghost" id="ptPr">Профиль сюда</button><button class="ghost" id="ptCp">Копировать</button></div>`;
  const q = (s: string) => body.querySelector(s) as HTMLElement;
  q('#ptCoords').appendChild(coordsBlock(p.lat, p.lon, S.coordFormat));
  elevationAt(p).then((e) => {
    if (!body.isConnected) return;
    q('#ptH').textContent = e === null ? 'нет данных' : `${Math.round(e)} м`;
    const rel = body.querySelector('#ptRel');
    if (rel) rel.textContent = e === null || stationGround === null ? '—' : hereText(e, stationGround, true).replace(' пульта', '').replace(' с пультом', '');
  });
  q('#ptSt').addEventListener('click', () => { setStation(p); closeSheet(); toast('Пульт поставлен'); });
  q('#ptMk').addEventListener('click', () => addMarkAt(p)); // откроет карточку метки (как кнопка «Метка» внизу)
  q('#ptPr').addEventListener('click', () => showProfile(p));
  q('#ptCp').addEventListener('click', () => {
    const text = formatCoords(p.lat, p.lon, S.coordFormat).short.replace(/<\/?em>/g, '');
    if (!navigator.clipboard?.writeText) { toast(`Скопируйте вручную: ${text}`, 6000); return; }
    navigator.clipboard.writeText(text).then(() => toast('Координаты скопированы'), () => toast(`Не удалось скопировать. Координаты: ${text}`, 6000));
  });
  openSheet('Точка', body, clearPin);
  clearPin();
  if (at) pointPin = new maplibregl.Marker({ element: h('<div class="pt-pin"></div>') }).setLngLat([p.lon, p.lat]).addTo(map);
}
