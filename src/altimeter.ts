// Высотомер у правого края: вертикальная шкала высоты дрона. Полосы — какая связь будет на каждой высоте
// для текущей трассы пульт → прицел (их считает live.ts), внизу — склон, если прицел выше пульта.
// Дрон — метка на шкале: её тянут пальцем (строка связи показывает результат сразу, пересчёт — по отпусканию),
// нажатие на подпись — ввести точное число.
import { S, $, emit, on, toast } from './app';
import { dialog } from './ui';
import { STATUS_MAP } from './theme';
import { AltBand, AltLevel, altBands, scaleTop, altSnap } from './altScale';

const H_MAX = 5000; // как в меню «Аппаратура и высота»
// Без двойных позиций у цвета («#c 0 6px»): их нет в Chrome < 71 (пульты), там фон пропал бы целиком.
const GROUND_FILL = 'repeating-linear-gradient(135deg, #6b4f2f 0, #6b4f2f 6px, #4f3a22 6px, #4f3a22 12px)';
const PENDING_FILL = 'rgba(140, 140, 140, 0.45)';

let top = 300;
let bands: AltBand[] = [];
let dragH: number | null = null;
let onPreview: ((h: number) => void) | null = null;
let onPreviewEnd: (() => void) | null = null;

/** Подписка live.ts: показывать в строке связи результат для высоты под пальцем и вернуть обычный вид. */
export function setAltPreview(preview: (h: number) => void, end: () => void) { onPreview = preview; onPreviewEnd = end; }

/**
 * Новые данные трассы: level(h) — связь на высоте h, marks — важные высоты (нужные, склон) для верха шкалы.
 * null — трассы нет (пульт без высоты, прицел на пульте, нет рельефа): шкала серая, высоту менять можно.
 */
export function setAltData(d: { level: (h: number) => AltLevel; marks: number[] } | null) {
  top = scaleTop([S.droneH, ...(d ? d.marks : [])], top);
  bands = d ? altBands(d.level, top) : [];
  render();
}

const el = () => $('altimeter');
const track = () => el().querySelector('.alt-track') as HTMLElement;
const pct = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;

function tickStep(t: number) { return t <= 400 ? 100 : t <= 800 ? 200 : t <= 1200 ? 300 : 500; }

function render() {
  const root = el();
  root.hidden = !S.station;
  if (root.hidden) return;
  const bx = root.querySelector('.alt-bands') as HTMLElement;
  bx.innerHTML = '';
  const list = bands.length ? bands : [{ from: 0, to: top, level: 'pending' as const }];
  for (const b of list) {
    const d = document.createElement('div');
    d.className = `alt-band alt-${b.level}`;
    d.style.bottom = pct(b.from);
    d.style.height = pct(b.to - b.from);
    d.style.background = b.level === 'ground' ? GROUND_FILL : b.level === 'pending' ? PENDING_FILL : STATUS_MAP[b.level];
    if (b.level === 'ground' && b.to / top > 0.07) d.innerHTML = '<span>склон</span>'; // span — под плашку (styles/live.css)
    bx.appendChild(d);
  }
  const tx = root.querySelector('.alt-ticks') as HTMLElement;
  tx.innerHTML = '';
  const st = tickStep(top);
  // Внутри склона отметок нет — там подпись «склон» (иначе наезжают друг на друга).
  const slopeTop = bands.length && bands[0].level === 'ground' ? bands[0].to : 0;
  for (let v = st; v < top; v += st) {
    if (v < slopeTop) continue;
    const t = document.createElement('div');
    t.className = 'alt-tick';
    t.style.bottom = pct(v);
    t.textContent = String(v);
    tx.appendChild(t);
  }
  renderDrone();
}

function renderDrone() {
  const root = el();
  const hh = dragH ?? S.droneH;
  const mk = root.querySelector('.alt-drone') as HTMLElement;
  mk.style.bottom = pct(hh);
  (root.querySelector('.alt-lbl') as HTMLElement).textContent = `${Math.round(hh)}${hh > top ? '↑' : ''}`;
  root.setAttribute('aria-valuenow', String(Math.round(hh)));
  root.setAttribute('aria-valuetext', `${Math.round(hh)} метров над точкой взлёта`);
}

function heightAt(clientY: number): number {
  const r = track().getBoundingClientRect();
  const v = (1 - (clientY - r.top) / r.height) * top;
  const s = altSnap(top);
  return Math.max(0, Math.min(top, Math.round(v / s) * s));
}

function commit(hh: number) {
  dragH = null;
  const v = Math.max(0, Math.min(H_MAX, Math.round(hh)));
  if (v === S.droneH) { renderDrone(); onPreviewEnd?.(); return; }
  S.droneH = v;
  emit('radio'); // пересчёт строки связи, профиля и устаревание зоны
}

async function askExact() {
  const r = await dialog({
    title: 'Высота дрона',
    text: `Метры над точкой взлёта (как барометр в очках), от 0 до ${H_MAX}.`,
    input: { value: String(S.droneH), maxLength: 6, inputMode: 'decimal' },
    buttons: [{ text: 'Готово', value: true }],
  });
  if (!r) return;
  const v = parseFloat(r.input.replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > H_MAX) { toast(`Высота дрона: от 0 до ${H_MAX} м`); return; }
  commit(v);
}

export function initAltimeter() {
  const root = el();
  let pid = -1, startY = 0, moved = false, onLabel = false, dragged = false;
  const end = (e: PointerEvent, cancel: boolean) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    dragged = moved;
    if (cancel) { dragH = null; renderDrone(); onPreviewEnd?.(); return; }
    // Короткое нажатие на подпись — диалог по click (иначе следом пришедший click на телефоне попадёт в фон диалога).
    if (!moved && onLabel) return;
    commit(moved ? dragH ?? S.droneH : heightAt(e.clientY)); // короткое нажатие по шкале — сразу на эту высоту
  };
  // click приходит на сам высотомер (захват указателя у мыши) или на подпись (палец) — смотрим, где было нажатие.
  root.addEventListener('click', () => { if (onLabel && !dragged) void askExact(); dragged = false; });
  root.addEventListener('pointerdown', (e) => {
    if (pid !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pid = e.pointerId; startY = e.clientY; moved = false;
    onLabel = !!(e.target as HTMLElement).closest('.alt-lbl');
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  root.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    if (!moved && Math.abs(e.clientY - startY) < 5) return;
    moved = true;
    const hh = heightAt(e.clientY);
    if (hh === dragH) return;
    dragH = hh;
    renderDrone();
    onPreview?.(hh);
  });
  root.addEventListener('pointerup', (e) => end(e, false));
  root.addEventListener('pointercancel', (e) => end(e, true));
  root.addEventListener('keydown', (e) => {
    const s = altSnap(top);
    const d = e.key === 'ArrowUp' ? s : e.key === 'ArrowDown' ? -s : e.key === 'PageUp' ? 5 * s : e.key === 'PageDown' ? -5 * s : 0;
    if (d) { e.preventDefault(); commit(Math.max(0, S.droneH + d)); }
    else if (e.key === 'Enter') { e.preventDefault(); void askExact(); }
  });
  on('station', render);
  on('radio', render);
  render();
}
