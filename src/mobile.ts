// Мобильное поведение: шторка-лист (ручка, свайп вниз), долгое нажатие/правый клик по карте,
// inputmode для числовых полей. Стили — в styles/main.css.
import { map, $, closeSheet } from './app';
import type { LatLon } from './geo';

const LONG_MS = 600;
const MOVE_PX = 10;
const portraitSheet = () => window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches;

export function initMobile(opts: { onPointPress: (p: LatLon) => void }) {
  // Масштабирование жестом на iOS (user-scalable там игнорируется).
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault());

  initSheetDrag();
  initLongPress(opts.onPointPress);
  initInputModes();
}

function initSheetDrag() {
  const sheet = $('sheet');
  let startY = 0, dy = 0, id = -1, t0 = 0;
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    sheet.classList.remove('dragging');
    const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
    if (dy > 90 || (dy > 30 && fast)) closeSheet();
    sheet.style.removeProperty('--drag');
    dy = 0;
  };
  const start = (e: PointerEvent) => {
    if (!portraitSheet() || id !== -1 || (e.target as HTMLElement).closest('button')) return;
    id = e.pointerId; startY = e.clientY; dy = 0; t0 = Date.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  };
  for (const el of [$('shGrip'), sheet.querySelector('.sh-head') as HTMLElement]) {
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.setProperty('--drag', `${dy}px`);
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

function initLongPress(onPoint: (p: LatLon) => void) {
  const cont = map.getCanvasContainer();
  let timer = 0, sx = 0, sy = 0, pid = -1, lastTouch = 0, lastFire = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; pid = -1; };
  const fire = (x: number, y: number) => {
    lastFire = Date.now();
    const ll = map.unproject([x, y]);
    navigator.vibrate?.(15);
    onPoint({ lat: ll.lat, lon: ll.lng });
  };
  cont.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    lastTouch = Date.now();
    if (pid !== -1) { cancel(); return; } // второй палец — это жест масштаба
    const r = cont.getBoundingClientRect();
    pid = e.pointerId; sx = e.clientX; sy = e.clientY;
    timer = window.setTimeout(() => { timer = 0; fire(sx - r.left, sy - r.top); }, LONG_MS);
  });
  cont.addEventListener('pointermove', (e) => {
    if (e.pointerId === pid && Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_PX) cancel();
  });
  for (const t of ['pointerup', 'pointercancel']) cont.addEventListener(t, (e) => { if ((e as PointerEvent).pointerId === pid) cancel(); });
  map.on('movestart', cancel);
  map.on('zoomstart', cancel);

  // Десктоп: правый клик. Родное меню долгого нажатия на телефоне подавляем.
  cont.addEventListener('contextmenu', (e) => e.preventDefault());
  map.on('contextmenu', (e) => {
    if (Date.now() - lastTouch < 2000 || Date.now() - lastFire < 1000) return;
    onPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
}

/** Числовым полям без inputmode — десятичную/цифровую клавиатуру. */
function initInputModes() {
  const SEL = 'input[type="number"]:not([inputmode])';
  const one = (i: HTMLInputElement) => {
    const min = i.min === '' ? NaN : Number(i.min);
    if (!(min >= 0)) return; // с минусом нужна обычная клавиатура
    const step = Number(i.step || 1);
    i.inputMode = Number.isInteger(step) && step >= 1 ? 'numeric' : 'decimal';
  };
  const fix = (root: Element | Document) => {
    if (root instanceof HTMLInputElement && root.matches(SEL)) one(root);
    root.querySelectorAll<HTMLInputElement>(SEL).forEach(one);
  };
  fix(document);
  // Поля создаются только в шторке и меню: следим за ними и смотрим лишь добавленные узлы
  // (а не весь документ при каждой перерисовке строки связи).
  const mo = new MutationObserver((recs) => {
    for (const r of recs) r.addedNodes.forEach((n) => { if (n instanceof Element) fix(n); });
  });
  for (const id of ['shBody', 'drBody']) mo.observe($(id), { childList: true, subtree: true });
}
