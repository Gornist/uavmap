// Левое меню: каркас ящика (открыть/закрыть, список разделов, «Назад») и перерисовка по событиям.
// Разделы — в соседних файлах; с другими модулями меню общается через S, emit, on и их публичные функции.
import '../styles/menu.css';
import { $, on } from '../app';
import { h } from '../ui';
import { close, isOpen, quiet, setRender } from './common';
import { preload } from '../lazy';

type MenuSection = 'hardware' | 'map' | 'offline' | 'files' | 'tools' | 'settings';

const ITEMS: { id: MenuSection; ico: string; title: string; sub: string }[] = [
  { id: 'hardware', ico: '📡', title: 'Аппаратура и высота', sub: 'управление, видео, местность у пульта' },
  { id: 'map', ico: '🗺', title: 'Карта', sub: 'подложка, рельеф, подписи и дороги' },
  { id: 'offline', ico: '📥', title: 'Офлайн', sub: 'районы без сети, свои карты' },
  { id: 'files', ico: '⚑', title: 'Метки и файлы', sub: 'метки, импорт, экспорт, копия' },
  { id: 'tools', ico: '📏', title: 'Инструменты', sub: 'линейка, маршруты' },
  { id: 'settings', ico: '⚙', title: 'Настройки и справка', sub: 'тема, координаты, помощь' },
];

const TITLES = Object.fromEntries(ITEMS.map((i) => [i.id, i.title])) as Record<MenuSection, string>;
type SectionFn = (el: HTMLElement) => void;
// Разделы — отдельными чанками (lazy.ts): на старте не нужны, подгружаются в простое после загрузки карты.
const LOADERS: Record<MenuSection, () => Promise<SectionFn>> = {
  hardware: () => import('./hardware').then((m) => m.hardware),
  map: () => import('./map').then((m) => m.mapSection),
  offline: () => import('./offline').then((m) => m.offlineSection),
  files: () => import('./files').then((m) => m.files),
  tools: () => import('./tools').then((m) => m.tools),
  settings: () => import('./settings').then((m) => m.settings),
};
const SECTIONS: Partial<Record<MenuSection, SectionFn>> = {};
const loadSection = (id: MenuSection) => LOADERS[id]().then((f) => (SECTIONS[id] = f));

/** Подгрузить разделы меню и шторку профиля заранее (в простое). */
export const preloadUi = () => preload((Object.keys(LOADERS) as MenuSection[]).map((id) => () => loadSection(id)));

let current: MenuSection | null = null;

export function initMenu(): void {
  setRender(render);
  $('btnMenu').addEventListener('click', () => openMenu());
  const x = $('drClose');
  x.addEventListener('click', close);
  x.setAttribute('aria-label', 'Закрыть меню');
  x.title = 'Закрыть меню';
  $('scrim').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  for (const ev of ['station', 'radio', 'height', 'antenna', 'marks', 'routes', 'coords'] as const) {
    on(ev, () => { if (isOpen() && current && !quiet) render(); });
  }
}

/** Открыть меню (на главном списке или сразу в разделе). */
export function openMenu(section?: MenuSection): void {
  current = section ?? null;
  document.body.classList.add('drawer-open');
  $('drawer').setAttribute('aria-hidden', 'false');
  render();
}

function render() {
  const body = $('drBody');
  const top = body.scrollTop;
  body.innerHTML = '';
  if (!current) { body.appendChild(mainList()); return; }
  const head = h('<div class="dr-top"><button class="dr-back" type="button">‹ Назад</button><b></b></div>');
  head.querySelector('b')!.textContent = TITLES[current];
  head.querySelector('button')!.addEventListener('click', () => { current = null; render(); });
  const sec = h('<div class="dr-sec"></div>');
  const fn = SECTIONS[current];
  if (fn) fn(sec);
  else {
    sec.appendChild(h('<p class="muted">Загрузка…</p>'));
    const id = current;
    loadSection(id).then(() => { if (isOpen() && current === id) render(); },
      () => { sec.innerHTML = '<p class="muted">Не удалось загрузить раздел — обновите страницу.</p>'; });
  }
  body.append(head, sec);
  body.scrollTop = top;
}

function mainList() {
  const box = h('<div></div>');
  for (const it of ITEMS) {
    const b = h('<button class="dr-item" type="button"><span class="ico" aria-hidden="true"></span><span><b></b><small></small></span></button>');
    b.querySelector('.ico')!.textContent = it.ico;
    b.querySelector('b')!.textContent = it.title;
    b.querySelector('small')!.textContent = it.sub;
    b.addEventListener('click', () => { current = it.id; $('drBody').scrollTop = 0; render(); });
    box.appendChild(b);
  }
  return box;
}
