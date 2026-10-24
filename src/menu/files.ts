// Меню → «Метки и файлы»: список меток, переход к координатам, импорт GeoJSON/GPX/KML, экспорт с выбором формата,
// резервная копия проекта. Пульт здесь — только ссылка «Показать пульт» (его карточка открывается на карте).
import { S, $, map, toast, emit } from '../app';
import { h, button, dialog, confirmDialog } from '../ui';
import { MARK_COLOR, saveNow, restoreProject, importText, toGeoJSON, toGPX, toKML, download } from '../store';
import { parseCoords } from '../coords';
import { openMark } from '../marks';
import { close, section } from './common';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_MB = MAX_FILE / 1024 / 1024;

type Fmt = 'geojson' | 'gpx' | 'kml';
const EXPORT: Record<Fmt, { name: string; file: string; type: string; data: () => string }> = {
  geojson: { name: 'GeoJSON', file: 'uavmap.geojson', type: 'application/geo+json', data: () => JSON.stringify(toGeoJSON(S), null, 1) },
  gpx: { name: 'GPX', file: 'uavmap.gpx', type: 'application/gpx+xml', data: () => toGPX(S) },
  kml: { name: 'KML', file: 'uavmap.kml', type: 'application/vnd.google-earth.kml+xml', data: () => toKML(S) },
};

const flyTo = (lon: number, lat: number, zoom: number) => { close(); map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) }); };

export function files(el: HTMLElement) {
  const st = S.station;
  if (st) el.appendChild(h('<div class="row"></div>')).appendChild(button('📡 Показать пульт', 'ghost', () => flyTo(st.lon, st.lat, 13)));

  section(el, `Метки (${S.marks.length})`);
  if (!S.marks.length) el.appendChild(h('<p class="hint">Меток нет. Кнопка «Метка» внизу ставит метку в прицел.</p>'));
  const ml = h('<div class="list"></div>');
  for (const m of S.marks) {
    const li = h('<button class="li" type="button"><span class="dot"></span><span class="t"></span></button>');
    (li.querySelector('.dot') as HTMLElement).style.background = /^#[0-9a-fA-F]{3,8}$/.test(m.color) ? m.color : MARK_COLOR;
    li.querySelector('.t')!.textContent = m.name || 'Метка';
    li.addEventListener('click', () => { flyTo(m.lon, m.lat, 14); openMark(m.id); });
    ml.appendChild(li);
  }
  el.appendChild(ml);

  section(el, 'Перейти к координатам');
  const go = h('<div class="row go-row"><input type="text" placeholder="55.75 37.62 или X 6175000 Y 7412000" aria-label="Координаты"></div>');
  const gi = go.querySelector('input') as HTMLInputElement;
  const doGo = () => {
    const p = parseCoords(gi.value);
    if (!p) { toast('Не понял координаты. Пример: 55.75 37.62 или X 6175000 Y 7412000', 4000); gi.focus(); return; }
    flyTo(p.lon, p.lat, 14);
  };
  gi.addEventListener('keydown', (e) => { if (e.key === 'Enter') doGo(); });
  go.appendChild(button('Перейти', 'primary', doGo));
  el.appendChild(go);

  section(el, 'Файлы');
  el.appendChild(h(`<p class="hint">Импорт: GeoJSON, GPX или KML до ${MAX_MB} МБ — метки и маршруты добавятся к текущим.</p>`));
  const io = h('<div class="row row-2"></div>');
  io.append(
    button('Импортировать…', 'ghost', () => $('fileIn').click()),
    button('Экспортировать…', 'ghost', () => void exportAll()),
  );
  el.appendChild(io);
  const fin = $('fileIn') as HTMLInputElement;
  fin.onchange = async () => {
    const f = fin.files?.[0];
    fin.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { toast(`Файл больше ${MAX_MB} МБ — разделите его на части`, 4000); return; }
    try {
      const r = importText(await f.text(), f.name);
      // Без spread: у push(...arr) есть предел числа аргументов (большие файлы).
      for (const m of r.marks) S.marks.push(m);
      for (const rt of r.routes) S.routes.push(rt);
      emit('marks'); emit('routes');
      toast(`Добавлено: меток ${r.marks.length}, маршрутов ${r.routes.length}`);
    } catch (e) {
      toast(`Не удалось прочитать файл: ${e instanceof Error ? e.message : 'ошибка разбора'}. Проверьте, что это GeoJSON, GPX или KML`, 5000);
    }
  };

  section(el, 'Карта в файл и печать');
  el.appendChild(h('<p class="hint">Картинка — карта как на экране с пультом, метками, зоной и сведениями внизу. Лист — карта, профиль до прицела и таблица связи; в окне печати можно выбрать «Сохранить как PDF».</p>'));
  const ex = h('<div class="row row-2"></div>');
  const exportMod = () => import('../exportSheet');
  const fail = () => toast('Не удалось загрузить часть приложения — обновите страницу', 5000);
  ex.append(
    button('Картинка карты', 'ghost', () => { close(); void exportMod().then((m) => m.exportImage(), fail); }),
    button('Лист для печати', 'ghost', () => { close(); void exportMod().then((m) => m.printSheet(), fail); }),
  );
  el.appendChild(ex);

  section(el, 'Резервная копия проекта');
  el.appendChild(h('<p class="hint">Всё хранится только на этом устройстве. Копия — весь проект одним файлом: пульт, метки, маршруты, аппаратура, антенны, настройки. Скачанные районы рельефа и свои карты в копию не входят — их файлы большие.</p>'));
  const row2 = h('<div class="row row-2"></div>');
  row2.append(
    button('Сохранить копию', 'ghost', () => {
      const d = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
      download(`uavmap-проект-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`, JSON.stringify(S), 'application/json');
    }),
    button('Восстановить…', 'ghost', () => bk.click()),
  );
  const bk = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  bk.onchange = async () => {
    const f = bk.files?.[0];
    bk.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { toast(`Файл больше ${MAX_MB} МБ — это не копия проекта`, 4000); return; }
    let st;
    try {
      st = restoreProject(await f.text());
    } catch (e) {
      toast(`${e instanceof Error ? e.message : 'Не удалось прочитать копию'}. Выберите файл uavmap-проект-….json`, 5000);
      return;
    }
    if (!(await confirmDialog('Восстановить из копии?', 'Текущие пульт, метки, маршруты и настройки на этом устройстве заменятся копией из файла.', 'Заменить'))) return;
    try { saveNow(st); } catch (e) {
      toast(`${e instanceof Error ? e.message : 'Не удалось сохранить копию'}. Проект не изменён.`, 6000);
      return;
    }
    location.reload();
  };
  el.appendChild(row2);
}

async function exportAll() {
  if (!S.marks.length && !S.routes.length && !S.station) { toast('Нечего экспортировать: нет пульта, меток и маршрутов'); return; }
  const r = await dialog<Fmt>({
    title: 'Экспорт в файл',
    text: `Меток: ${S.marks.length} · маршрутов: ${S.routes.length}${S.station ? ' · пульт' : ''}. GeoJSON — для большинства программ, GPX — для навигаторов, KML — для Google Earth.`,
    buttons: (Object.keys(EXPORT) as Fmt[]).map((f) => ({ text: EXPORT[f].name, value: f, def: f === 'geojson' })),
  });
  if (!r) return;
  const e = EXPORT[r.value];
  download(e.file, e.data(), e.type);
}
