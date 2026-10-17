// Меню → «Настройки и справка»: тема, формат координат, во весь экран, сброс проекта, помощь, источники и о программе.
import { S, BASES, emit, toast } from '../app';
import { h, button, details, confirmDialog } from '../ui';
import { clearSaved } from '../store';
import { CoordFormat } from '../coords';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
import { readOpt, setReadOpt, type ReadOpt } from '../readability';
import { close, render, section } from './common';

const REPO = 'https://github.com/Gornist/uavmap';

// Chrome 68 знает только webkit-префикс полноэкранного API.
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const fsDoc = document as FsDoc;
const fsElement = () => fsDoc.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;

/** «Во весь экран» имеет смысл, только если API есть и приложение не установлено (в PWA и так весь экран). */
export function canFullscreen(): boolean {
  const installed = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  const iosApp = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (installed || iosApp) return false;
  const el = document.documentElement as FsEl;
  return !!((fsDoc.fullscreenEnabled ?? fsDoc.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen));
}

function toggleFullscreen() {
  if (fsElement()) {
    if (fsDoc.exitFullscreen) fsDoc.exitFullscreen().catch(() => undefined); else fsDoc.webkitExitFullscreen?.();
    return;
  }
  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) el.requestFullscreen().catch(() => toast('Браузер не разрешил полный экран'));
    else el.webkitRequestFullscreen?.();
  } catch { toast('Браузер не разрешил полный экран'); }
}

const HELP: [string, string[]][] = [
  ['Как пользоваться', [
    '1. Наведите прицел на место, где будете стоять, и нажмите «Пульт здесь» (или «По GPS»).',
    '2. Двигайте карту: строка связи вверху покажет, будет ли связь с дроном над прицелом и до какой высоты подняться. Нажмите на строку — откроется разрез местности до прицела: что мешает.',
    '3. Вокруг пульта сами рисуются две границы связи; «Зона» закрашивает карту, «Где встать» подскажет место для пульта.',
  ]],
  ['Высотомер слева', [
    'Высота дрона в метрах над точкой взлёта — как барометр в очках. Цвет шкалы — какая будет связь на этой высоте при полёте к прицелу: зелёный — есть, жёлтый — на грани, красный — нет; коричневая штриховка «склон» — у прицела дрон оказался бы ниже земли, серый — ещё не посчитано.',
    'Подпись «связь от N м» у шкалы — та же высота, что в строке связи. Тяните белую плашку или нажмите на шкалу; нажмите на число — ввести точно.',
  ]],
  ['Радиогоризонт сам', [
    'После установки пульта вокруг него сами рисуются две границы: золотая — до куда дойдёт управление, голубая — видео. Пересчитываются при смене пульта, аппаратуры, антенн и высоты дрона.',
    '«Зона» → «Закрасить» — залить карту цветом связи без пересчёта, «Рассчитать» — посчитать заново с другим радиусом. Выключить — ✕ на плашке над картой или галочка «Радиогоризонт сам» в «Зоне».',
  ]],
  ['Антенны на земле', [
    'Нажмите на 📡 (маркер пульта): для управления и видео — тип антенны (всенаправленная, патч, яги, своя) и азимут с румбом, «На прицел» — развернуть на прицел. Лучи направленных антенн видны на карте.',
    'Если прицел вне луча, строка связи скажет об этом — кнопка «Повернуть» развернёт антенну.',
  ]],
  ['Кнопки справа внизу', [
    '«Линия к прицелу» — показать линию от пульта к прицелу цветом связи и метки, где по пути пропадёт связь. «Где я» — найти себя по GPS и предложить поставить пульт сюда. ⌂ — вернуться к пульту.',
  ]],
  ['Что значат «есть / на грани / нет»', [
    'Линий две — управление и видео; итог — по худшей. Видео обычно пропадает раньше.',
    '«Запас» — насколько сигнал сильнее минимально нужного. Запас не меньше желаемого — связь есть; меньше — на грани, возможны срывы; ниже нуля — связи нет.',
  ]],
  ['Рельеф и плохая сеть', [
    'Рельеф берётся с Mapterhorn; если он не отвечает — с запасного сервера AWS. Сразу после установки пульта район вокруг него подкачивается в память — дальше расчёты не ждут сеть. Для полёта без интернета скачайте район заранее («Офлайн»).',
  ]],
  ['На солнце и в перчатках', [
    'Выше в этом разделе: «Яркое солнце» — плотные плашки под цифрами и подписями на карте, «Крупный текст» — крупнее строка связи, высотомер и кнопки.',
  ]],
  ['Что не учитывается', [
    'Лес и здания вдоль трассы, помехи и погода. Лес или посёлок у пульта задаётся в «Аппаратура и высота» → «Местность у пульта». Расчёт — оценка, а не гарантия связи.',
  ]],
];

export function settings(el: HTMLElement) {
  section(el, 'Тема');
  const tseg = h('<div class="seg"></div>');
  for (const [t, label] of [['auto', 'Авто'], ['day', 'День'], ['night', 'Ночь']] as [ThemeChoice, string][]) {
    tseg.appendChild(button(label, getTheme() === t ? 'on' : '', () => { setTheme(t); render(); }));
  }
  el.appendChild(tseg);
  el.appendChild(h('<p class="hint muted">Авто — по настройке телефона или времени суток.</p>'));

  section(el, 'Читаемость');
  for (const [o, label, hint] of [
    ['sun', 'Яркое солнце', 'плотные плашки под цифрами и подписями на карте; на солнце удобнее тема «День»'],
    ['big-text', 'Крупный текст', 'строка связи, высотомер, кнопки и шторки'],
  ] as [ReadOpt, string, string][]) {
    const c = h('<label class="chk"><input type="checkbox"><span><span class="chk-t"></span><small class="muted"></small></span></label>');
    c.querySelector('.chk-t')!.textContent = label;
    c.querySelector('small')!.textContent = hint;
    const i = c.querySelector('input') as HTMLInputElement;
    i.checked = readOpt(o);
    i.addEventListener('change', () => setReadOpt(o, i.checked));
    el.appendChild(c);
  }

  section(el, 'Формат координат');
  const seg = h('<div class="seg"></div>');
  for (const [f, t] of [['sk42', 'СК-42'], ['dd', 'Градусы'], ['dms', 'Г°М′С″']] as [CoordFormat, string][]) {
    seg.appendChild(button(t, S.coordFormat === f ? 'on' : '', () => { S.coordFormat = f; emit('coords'); render(); }));
  }
  el.appendChild(seg);

  if (canFullscreen()) {
    section(el, 'Экран');
    el.appendChild(button(fsElement() ? 'Выйти из полноэкранного режима' : '⛶ Во весь экран', 'ghost', () => { close(); toggleFullscreen(); }));
  }

  section(el, 'Проект');
  el.appendChild(button('Сбросить проект…', 'danger', async () => {
    if (!(await confirmDialog('Сбросить проект?', 'Удалятся пульт, все метки, маршруты и настройки на этом устройстве. Сначала можно сохранить резервную копию («Метки и файлы»).', 'Сбросить'))) return;
    clearSaved();
    location.reload();
  }));

  section(el, 'Справка');
  for (const [t, ps] of HELP) {
    const d = details(t, false);
    for (const s of ps) { const p = h('<p class="hint"></p>'); p.textContent = s; d.appendChild(p); }
    el.appendChild(d);
  }
  const about = details('Источники данных и о программе', false);
  const src = h('<p class="hint"></p>');
  src.textContent = `Рельеф: Mapterhorn (Copernicus GLO-30 и национальные модели рельефа; лицензии — mapterhorn.com/attribution); если не отвечает — AWS Terrain Tiles (Mapzen: SRTM, GMTED и др.). Подложка: ${BASES[S.map.base]?.attr ?? '—'}. Подписи и дороги: OpenFreeMap, © OpenMapTiles, © участники OpenStreetMap (если не грузятся — запасные © Esri). Модель распространения: ITU-R P.526-15.`;
  about.appendChild(src);
  const p = h('<p class="hint">Радиус — гражданская карта радиовидимости дрона. Исходный код: <a target="_blank" rel="noopener"></a></p>');
  const a = p.querySelector('a') as HTMLAnchorElement;
  a.href = REPO; a.textContent = REPO;
  about.appendChild(p);
  el.appendChild(about);
}
