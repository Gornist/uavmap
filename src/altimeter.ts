// Высотомер у правого края: вертикальная шкала высоты дрона. Полосы — какая связь будет на каждой высоте
// для текущей трассы пульт → прицел (их считает live.ts), внизу — склон, если прицел выше пульта.
// Дрон — метка на шкале: её тянут пальцем (строка связи показывает результат сразу, пересчёт — по отпусканию),
// нажатие на подпись — ввести точное число. Справа от шкалы — подпись «связь от N м» (то же N, что в строке связи);
// при первом посчитанном пути — подсказка, как читать шкалу (один раз на устройство).
import { S, $, emit, on, toast } from './app';
import { dialog } from './ui';
import { STATUS_MAP } from './theme';
import { AltBand, AltLevel, AltNeed, altBands, altNeed, scaleTop, altSnap } from './altScale';
import type { HeightNeeds } from './verdict';

const H_MAX = 5000; // как в меню «Аппаратура и высота»
// Без двойных позиций у цвета («#c 0 6px»): их нет в Chrome < 71 (пульты), там фон пропал бы целиком.
const GROUND_FILL = 'repeating-linear-gradient(135deg, #6b4f2f 0, #6b4f2f 6px, #4f3a22 6px, #4f3a22 12px)';
const PENDING_FILL = 'rgba(140, 140, 140, 0.45)';

let top = 300;
let bands: AltBand[] = [];
let line: 'video' | 'rc' = 'video'; // чью связь показывает цвет шкалы
/** Подпись «упр. от N м»: управлению нужно выше, чем видео (иначе на высоте «видео есть» дрон уйдёт в возврат). */
let rcNeed: number | null = null;
const RC_SAME_M = 5;
let need: AltNeed | null = null;
let dragH: number | null = null;
let onPreview: ((h: number) => void) | null = null;
let onPreviewEnd: (() => void) | null = null;

/** Подписка live.ts: показывать в строке связи результат для высоты под пальцем и вернуть обычный вид. */
export function setAltPreview(preview: (h: number) => void, end: () => void) { onPreview = preview; onPreviewEnd = end; }

/**
 * Новые данные трассы: level(h) — связь линии line (видео; нет видеоприёмника — управление) на высоте h,
 * marks — важные высоты (нужные, склон) для верха шкалы, needs — нужные высоты из подсказки строки связи:
 * подписи «видео от N м» и «упр. от N м» у шкалы — с теми же числами.
 * null — трассы нет (пульт без высоты, прицел на пульте, нет рельефа): шкала серая, высоту менять можно.
 */
export function setAltData(d: { level: (h: number) => AltLevel; marks: number[]; needs: HeightNeeds; line: 'video' | 'rc' } | null) {
  top = scaleTop([S.droneH, ...(d ? d.marks : [])], top);
  bands = d ? altBands(d.level, top, 40, [d.needs.rc, d.needs.video, d.needs.pair].filter((v): v is number => typeof v === 'number')) : [];
  line = d ? d.line : 'video';
  const own = d ? (line === 'video' ? d.needs.video ?? null : d.needs.rc) : null;
  need = d ? altNeed(bands, own, top, [own]) : null;
  const rc = d && line === 'video' ? d.needs.rc : null;
  // Порог тот же (гребень склона: границы ищутся разными способами и расходятся на 1–2 м) — вторая подпись — шум.
  rcNeed = rc !== null && rc > 0 && rc < top && (!need || rc > need.h + RC_SAME_M) ? rc : null;
  render();
  if (d) maybeHint();
}

const el = () => $('altimeter');
const track = () => el().querySelector('.alt-track') as HTMLElement;
const pct = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;

function tickStep(t: number) { return t <= 400 ? 100 : t <= 800 ? 200 : t <= 1200 ? 300 : 500; }

function render() {
  const root = el();
  root.hidden = !S.station;
  if (root.hidden) { removeHint(); return; }
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
  // Подпись справа от шкалы (снаружи: не под бегунком и не на отметках); pointer-events: none — тап уходит на карту.
  if (need) {
    const n = document.createElement('div');
    n.className = `alt-need alt-need-${need.level}`;
    n.style.bottom = pct(need.h);
    n.textContent = needText();
    tx.appendChild(n);
  }
  if (rcNeed !== null) {
    const n = document.createElement('div');
    n.className = 'alt-need alt-need-rc';
    // Близко к подписи видео — приподнять, чтобы не наехала (подпись ~18 px); уголок тогда чуть выше своей высоты.
    const gap = need ? ((rcNeed - need.h) / top) * track().clientHeight : Infinity;
    n.style.bottom = gap < 20 ? `calc(${pct(rcNeed)} + ${Math.round(20 - gap)}px)` : pct(rcNeed);
    n.textContent = `упр. от ${rcNeed} м`;
    tx.appendChild(n);
  }
  renderDrone();
}

/** «видео от 440 м», «видео на грани от 300 м»; без видеоприёмника — «связь от …». */
function needText(): string {
  if (!need) return '';
  const who = line === 'video' ? 'видео' : 'связь';
  return `${who}${need.level === 'ok' ? '' : ' на грани'} от ${need.h} м`;
}

function renderDrone() {
  const root = el();
  const hh = dragH ?? S.droneH;
  const mk = root.querySelector('.alt-drone') as HTMLElement;
  mk.style.bottom = pct(hh);
  (root.querySelector('.alt-lbl') as HTMLElement).textContent = `${Math.round(hh)}${hh > top ? '↑' : ''}`;
  root.setAttribute('aria-valuenow', String(Math.round(hh)));
  const nt = (need ? `; ${needText()}` : '') + (rcNeed !== null ? `; управление от ${rcNeed} м` : '');
  root.setAttribute('aria-valuetext', `${Math.round(hh)} метров над точкой взлёта${nt}`);
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
  emit('height'); // пересчёт строки связи; зона покажет эту высоту (посчитана) или пересчитается
}

// ---------- Подсказка при первом запуске ----------

const HINT_KEY = 'uavmap.ui.altHint';
let hintEl: HTMLElement | null = null;
let hintDone = false; // в этом запуске уже закрыли (или хранилище говорит «видел»)

const hintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } };

/** Тап мимо подсказки закрывает её; сам тап не перехватываем — он делает своё (карта, высотомер, кнопки). */
function onOutside(e: Event) {
  if (hintEl && !hintEl.contains(e.target as Node)) closeHint();
}

function removeHint() {
  if (!hintEl) return;
  hintEl.remove();
  hintEl = null;
  document.removeEventListener('pointerdown', onOutside, true);
}

function closeHint() {
  removeHint();
  hintDone = true;
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* нет места — покажем ещё раз при следующем запуске */ }
}

/**
 * Один раз на устройство — при первом посчитанном пути, когда высотомер виден: не под шторкой, меню или линейкой
 * (тогда — при следующем расчёте) и не под тостом (тогда — когда он уйдёт). Расстановка — styles/layout.css (.alt-hint), оформление — live.css.
 */
let hintRetry = 0;
function maybeHint() {
  if (hintDone || hintEl || !bands.length) return;
  const root = el(), b = document.body.classList;
  if (root.hidden || !root.offsetWidth || b.contains('sheet-open') || b.contains('drawer-open') || b.contains('ruler-on')) return;
  if (hintSeen()) { hintDone = true; return; }
  // Тост («Пульт поставлен…») стоит там же, внизу, и закрыл бы «Понятно» — ждём, пока он уйдёт.
  if ($('toast').classList.contains('show')) {
    if (!hintRetry) hintRetry = window.setTimeout(() => { hintRetry = 0; maybeHint(); }, 800);
    return;
  }
  const sw = (lv: 'ok' | 'weak' | 'none' | 'ground') =>
    `<i style="background:${lv === 'ground' ? GROUND_FILL : STATUS_MAP[lv]}"></i>`;
  const d = document.createElement('div');
  d.id = 'altHint';
  d.className = 'alt-hint';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-label', 'Как читать высотомер');
  d.innerHTML = '<b>Шкала слева — высота дрона</b>'
    + `<p>Метры над точкой взлёта, как барометр в очках. Цвет — ${line === 'video' ? 'видео' : 'связь'} на этой высоте при полёте к прицелу:</p>`
    + `<p class="alt-hint-lg">${sw('ok')}есть ${sw('weak')}на грани ${sw('none')}нет ${sw('ground')}склон</p>`
    + '<p>Тяните белую плашку или нажмите на шкалу; нажмите на число — ввести точно.</p>'
    + '<button type="button" class="primary">Понятно</button>';
  (d.querySelector('button') as HTMLElement).addEventListener('click', closeHint);
  root.insertAdjacentElement('afterend', d);
  hintEl = d;
  document.addEventListener('pointerdown', onOutside, true);
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
  // Полосы приходят от live.ts (setAltData) после пересчёта трассы; здесь — видимость и метка дрона.
  on('station', render);
  on('height', render);
  render();
}
