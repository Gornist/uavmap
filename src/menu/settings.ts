// Меню → «Настройки и справка»: тема, формат координат, во весь экран, сброс проекта, помощь, источники и о программе.
import { S, BASES, emit, toast } from '../app';
import { h, button, details, confirmDialog } from '../ui';
import { clearSaved } from '../store';
import { CoordFormat } from '../coords';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
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
    '1. Наведите прицел на место пульта и нажмите «Пульт здесь» (или «По GPS»).',
    '2. Двигайте карту: строка связи внизу покажет, будет ли связь с дроном над прицелом и какая высота нужна.',
    '3. «Профиль» — разрез местности до прицела: что мешает и до какой высоты подняться.',
    '4. «Зона» закрашивает карту: зелёный — связь есть, жёлтый — на грани, красный — нет. «Где встать» подскажет место для пульта.',
  ]],
  ['Что значат «есть / на грани / нет»', [
    'Линий две — управление и видео; итог — по худшей. Видео обычно пропадает раньше.',
    '«Запас» — насколько сигнал сильнее минимально нужного. Запас не меньше желаемого — связь есть; меньше — на грани, возможны срывы; ниже нуля — связи нет.',
  ]],
  ['Что не учитывается', [
    'Лес и здания вдоль трассы, помехи, погода и направленность антенн. Лес или посёлок у пульта задаётся в «Аппаратура и высота» → «Местность у пульта». Расчёт — оценка, а не гарантия связи.',
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
  src.textContent = `Рельеф: Mapzen Terrain Tiles (AWS Open Data). Подложка: ${BASES[S.map.base]?.attr ?? '—'}. Подписи и дороги: © Esri. Модель распространения: ITU-R P.526-15.`;
  about.appendChild(src);
  const p = h('<p class="hint">Радиус — гражданская карта радиовидимости дрона. Исходный код: <a target="_blank" rel="noopener"></a></p>');
  const a = p.querySelector('a') as HTMLAnchorElement;
  a.href = REPO; a.textContent = REPO;
  about.appendChild(p);
  el.appendChild(about);
}
