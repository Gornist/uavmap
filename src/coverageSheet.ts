// Зона покрытия: шторка (радиус, «Рассчитать», итог словами, легенда; остальное — в «Ещё»),
// плашка зоны поверх карты (когда шторка закрыта) и точка входа области — initCoverage/openCoverageSheet.
// Высота показа — всегда общая S.droneH (её меняют в строке связи); список «Сравнить высоты» — в «Ещё».
import './styles/coverage.css';
import { S, map, toast, openSheet, closeSheet, persist, emit } from './app';
import { h, button, chips, details } from './ui';
import { COVERAGE_RADII_KM, demQualityHint } from './elevation';
import { freeSpaceRange } from './radio';
import { setStation, effRadio, effVideo, altModeText } from './station';
import { ICON } from './verdict';
import { km as fmtKm } from './format';
import { STATUS_RGB } from './theme';
import { COV_MAX_HEIGHTS } from './store';
import { openOfflineSheet } from './offline';
import { CoverageShown, CovLine, coverageHeights, heightIndex, lineOf, paletteIndex, sameHeights, stats } from './coverageStats';
import { PALETTE, initCoverageView, redrawCoverage, setCoverageOpacity } from './coverageView';
import { shown, stale, running, lastError, initCoverageRun, setCoverageListener, markInputsChanged, startCoverage, cancelCoverage, clearCoverage } from './coverageRun';

/** Названия цветов PALETTE (режим «нужная высота») — легенда словами, не только цветом. */
const PALETTE_NAME = ['салатовый', 'зелёный', 'бирюзовый', 'голубой', 'синий', 'сине-фиолетовый', 'фиолетовый', 'пурпурный'];
/** Телефон (узкий экран или альбомная ориентация): после расчёта шторка сворачивается в плашку. */
const PHONE_MQ = '(max-width: 640px), (max-height: 520px)';

let sheetBody: HTMLElement | null = null;
let pill: HTMLElement | null = null;
let collapseOnDone = false; // расчёт запущен из шторки на телефоне — свернуть её, когда будет готов точный результат
let toastedErr: typeof lastError = null;
let openMore = false; // «Ещё» раскрыто — переживает перерисовку

/** Слои зоны, плашка и подписка на смену пульта/радио; вызывать после загрузки стиля карты. */
export function initCoverage(): void {
  initCoverageView();
  initCoverageRun();
  pill = createPill();
  document.body.appendChild(pill);
  setCoverageListener(onChange);
}

function onChange() {
  if (lastError && lastError !== toastedErr && !sheetBody) { toastedErr = lastError; toast(lastError.text, 4000); }
  if (!running) {
    const done = shown && !shown.prelim;
    if (collapseOnDone && done && !lastError && sheetBody && matchMedia(PHONE_MQ).matches) closeSheet();
    collapseOnDone = false;
  }
  render();
  renderPill();
}

export function openCoverageSheet(): void {
  const body = openSheet('Зона покрытия', '', () => {
    if (sheetBody !== body) return;
    sheetBody = null;
    collapseOnDone = false;
    renderPill();
  });
  sheetBody = body;
  render();
  renderPill();
}

function sec(text: string) {
  const d = h('<div class="cov-sec"></div>');
  d.textContent = text;
  return d;
}

function hint(text: string, cls = 'hint') {
  const d = h(`<div class="${cls}"></div>`);
  d.textContent = text;
  return d;
}

/** Сегментный переключатель. */
function seg<T extends string>(items: readonly (readonly [T, string])[], cur: T, pick: (v: T) => void): HTMLElement {
  const box = h('<div class="seg"></div>');
  for (const [id, t] of items) box.appendChild(button(t, cur === id ? 'on' : '', () => pick(id)));
  return box;
}

const hm = (v: number) => `${Math.round(v)} м`;

function render() {
  const body = sheetBody;
  if (!body) return;
  body.innerHTML = '';
  const cov = S.coverage;

  if (!S.station) {
    body.appendChild(hint('Сначала нужен пульт — точка, от которой считается связь.'));
    body.appendChild(button('Поставить пульт в прицел', 'primary', () => {
      const c = map.getCenter();
      void setStation({ lat: c.lat, lon: c.lng }).then(render);
      render();
    }));
    return;
  }

  // Радиус и список высот — входные данные расчёта: прежний результат устаревает.
  const saveInput = () => { markInputsChanged(); persist(); render(); renderPill(); };
  const saveView = () => { persist(); redrawCoverage(); render(); renderPill(); };

  // ----- главное: радиус, «Рассчитать», результат -----
  body.appendChild(sec('Радиус'));
  body.appendChild(chips(COVERAGE_RADII_KM.map((km) => ({
    text: `${km} км`, on: cov.radius === km * 1000, click: () => { cov.radius = km * 1000; saveInput(); },
  }))));

  const row = h('<div class="row"></div>');
  if (running) row.appendChild(button('Отмена', 'ghost', () => { cancelCoverage(); collapseOnDone = false; render(); }));
  else row.appendChild(button('Рассчитать', 'primary', () => {
    void startCoverage();
    collapseOnDone = running && matchMedia(PHONE_MQ).matches; // running ставится синхронно — расчёт действительно начат
    render();
  }));
  body.appendChild(row);

  if (lastError && !running) {
    const err = h('<div class="cov-err" role="alert"></div>');
    err.appendChild(hint(lastError.text, 'cov-err-t'));
    if (lastError.dem) err.appendChild(button('Скачать район', 'ghost', () => openOfflineSheet()));
    body.appendChild(err);
  }

  if (shown) {
    renderSummary(body, shown);
    if (shown.prelim) body.appendChild(hint('Черновой расчёт — точный идёт, картинка обновится.', 'cov-prelim'));
    const note = staleNote(shown);
    if (note) body.appendChild(hint(note, 'cov-stale'));
    const x = h('<div class="row cov-clear"></div>');
    x.appendChild(button('Убрать с карты', 'ghost', () => clearCoverage()));
    body.appendChild(x);
  } else if (!running && !lastError) {
    body.appendChild(hint(`Считается для дрона на ${hm(S.droneH)} ${altModeText()} — высоту меняют в строке связи.`));
  }

  // ----- «Ещё»: сравнить высоты, закраска, линия, прозрачность, таблица -----
  const more = details('Ещё', openMore, (v) => { openMore = v; });

  more.appendChild(sec('Сравнить высоты'));
  const cmp = h('<label class="cov-check"><input type="checkbox"><span>Считать сразу несколько высот</span></label>');
  const cb = cmp.querySelector('input')!;
  cb.checked = cov.compare;
  cb.onchange = () => {
    cov.compare = cb.checked;
    if (!cov.compare && cov.show === 'minh') cov.show = 'margin';
    saveInput();
  };
  more.appendChild(cmp);
  if (cov.compare) {
    const hs = coverageHeights(cov.heights, S.droneH, true);
    more.appendChild(chips(hs.map((v) => v === S.droneH
      ? { text: `${hm(v)} · дрон`, on: true, click: () => toast('Высоту дрона меняют в строке связи') }
      : { text: `${hm(v)} ✕`, cls: 'x', click: () => { cov.heights = cov.heights.filter((x) => x !== v); saveInput(); } })));
    const add = h('<div class="cov-add"><input type="number" inputmode="numeric" min="1" max="5000" placeholder="м" aria-label="Высота, м"></div>');
    const inp = add.querySelector('input')!;
    add.appendChild(button('Добавить', 'ghost', () => {
      const v = Math.round(Number(inp.value));
      if (!(v >= 1 && v <= 5000)) { toast('Высота от 1 до 5000 м'); return; }
      if (hs.includes(v)) { toast('Такая высота уже есть'); return; }
      if (hs.length >= COV_MAX_HEIGHTS) { toast(`Не больше ${COV_MAX_HEIGHTS} высот`); return; }
      cov.heights = [...cov.heights.filter((x) => x !== v), v].sort((a, b) => a - b).slice(-COV_MAX_HEIGHTS);
      saveInput();
    }));
    more.appendChild(add);
    more.appendChild(hint(`Высота дрона входит всегда. Всего не больше ${COV_MAX_HEIGHTS} высот.`));
  }

  more.appendChild(sec('Что закрашивать'));
  more.appendChild(seg([['margin', 'Связь на высоте дрона'], ['minh', 'Нужную высоту']] as const, cov.show, (v) => {
    cov.show = v;
    if (v === 'minh' && !cov.compare) { cov.compare = true; markInputsChanged(); }
    saveView();
  }));
  if (cov.show === 'minh' && shown && shown.heights.length < 2) more.appendChild(hint('Нужная высота выбирается из нескольких высот — нажмите «Рассчитать».'));

  if (shown?.resV) {
    more.appendChild(sec('По какой линии'));
    more.appendChild(seg([['both', 'Обе'], ['rc', 'Управление'], ['video', 'Видео']] as const, cov.line, (v) => { cov.line = v; saveView(); }));
  }

  more.appendChild(sec('Прозрачность'));
  const op = h(`<input type="range" class="cov-opacity" min="0.1" max="1" step="0.05" aria-label="Прозрачность зоны">`) as HTMLInputElement;
  op.value = String(cov.opacity);
  op.oninput = () => {
    cov.opacity = Number(op.value);
    setCoverageOpacity(cov.opacity);
  };
  op.onchange = persist;
  more.appendChild(op);
  const q = demQualityHint(S.station.lat);
  if (q) more.appendChild(hint(q));

  if (shown) {
    more.appendChild(sec('Таблица по высотам'));
    renderTable(more, shown);
    more.appendChild(hint(S.video.enabled
      ? `Без рельефа связь держалась бы до: управление ${fmtKm(freeSpaceRange(effRadio()))}, видео ${fmtKm(freeSpaceRange(effVideo()))}.`
      : `Без рельефа связь держалась бы до ${fmtKm(freeSpaceRange(effRadio()))}.`));
  }
  body.appendChild(more);
}

/** Почему показанный результат может не соответствовать текущим настройкам (null — соответствует). */
function staleNote(c: CoverageShown): string | null {
  if (stale) return 'Пульт или настройки изменились — нажмите «Рассчитать» ещё раз.';
  const { i, exact } = heightIndex(c.heights, S.droneH);
  if (!exact) return `Дрон теперь на ${hm(S.droneH)}, на карте — ${hm(c.heights[i])}. Нажмите «Рассчитать».`;
  if (!sameHeights(coverageHeights(S.coverage.heights, S.droneH, S.coverage.compare), c.heights)) return 'Список высот изменился — нажмите «Рассчитать», чтобы сравнить.';
  return null;
}

const css = (s: 'ok' | 'weak' | 'none') => `rgb(${STATUS_RGB[s].join(',')})`;

/** Легенда: [цвет, текст]; в режиме «нужная высота» — какая высота каким цветом. */
function legendItems(c: CoverageShown): [string, string][] {
  if (S.coverage.show === 'margin' || c.heights.length < 2) {
    return [[css('ok'), `${ICON.ok} зелёный — связь есть`], [css('weak'), `${ICON.weak} жёлтый — на грани`], [css('none'), `${ICON.none} красный — нет связи`]];
  }
  const n = c.heights.length;
  const items = c.heights.map((v, i): [string, string] => {
    const k = paletteIndex(i, n, PALETTE.length);
    return [PALETTE[k], i === 0 ? `${PALETTE_NAME[k]} — хватит ${hm(v)}` : `${PALETTE_NAME[k]} — нужно ${hm(v)}`];
  });
  items.push(['rgba(128,128,128,0.5)', `серый — не хватит и ${hm(c.heights[n - 1])}`]);
  return items;
}

/** Главный результат словами + легенда. */
function renderSummary(body: HTMLElement, c: CoverageShown) {
  const line = lineOf(c, S.coverage.line);
  const { i } = heightIndex(c.heights, S.droneH);
  const st = stats(c, line)[i];
  const res = h('<div class="verdict-big cov-result"></div>');
  res.textContent = st.max <= 0
    ? `Связи нет даже у пульта · дрон ${hm(c.heights[i])}`
    : `Связь держится до ${fmtKm(st.median)} (в среднем) — максимум ${fmtKm(st.max)} · дрон ${hm(c.heights[i])}`;
  body.appendChild(res);
  if (c.resV) {
    const who = line === 'both' ? 'По худшей из двух линий' : line === 'video' ? 'Только по видео' : 'Только по управлению';
    body.appendChild(hint(`${who}, высота ${altModeText()}.`, 'hint'));
  }
  if (S.coverage.show === 'minh' && c.heights.length >= 2) body.appendChild(hint('Цвет на карте — какая высота дрона нужна для связи:', 'cov-sec'));
  const legend = h('<div class="legend"></div>');
  for (const [cl, txt] of legendItems(c)) {
    const sp = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = cl;
    sp.append(sw, txt);
    legend.appendChild(sp);
  }
  body.appendChild(legend);
}

function renderTable(body: HTMLElement, c: CoverageShown) {
  const cols: { name: string; line: CovLine }[] = c.resV
    ? [{ name: 'Упр.', line: 'rc' }, { name: 'Видео', line: 'video' }, { name: 'Обе', line: 'both' }]
    : [{ name: '', line: 'rc' }];
  const sts = cols.map((x) => stats(c, x.line));
  const t = h(c.resV
    ? '<table class="rt"><thead><tr><th>Высота</th><th>Упр.</th><th>Видео</th><th>Обе</th></tr></thead><tbody></tbody></table>'
    : '<table class="rt"><thead><tr><th>Высота</th><th>В среднем</th><th>Максимум</th><th>Площадь</th></tr></thead><tbody></tbody></table>');
  const tb = t.querySelector('tbody')!;
  const sel = heightIndex(c.heights, S.droneH);
  c.heights.forEach((hv, i) => {
    const tr = document.createElement('tr');
    if (sel.exact && i === sel.i) tr.classList.add('sel');
    const td = (txt: string) => { const x = document.createElement('td'); x.className = 'num'; x.textContent = txt; tr.appendChild(x); return x; };
    td(hm(hv));
    if (c.resV) {
      for (const st of sts) {
        const x = td(fmtKm(st[i].median));
        const sm = document.createElement('small');
        sm.textContent = `макс. ${fmtKm(st[i].max)} · ${Math.round(st[i].share * 100)}%`;
        x.appendChild(sm);
      }
    } else {
      const st = sts[0][i];
      td(fmtKm(st.median)); td(fmtKm(st.max)); td(`${Math.round(st.share * 100)}%`);
    }
    // Строка — выбрать высоту дрона: она общая (строка связи и профиль тоже переключатся).
    tr.onclick = () => {
      S.coverage.show = 'margin';
      S.droneH = hv;
      emit('radio');
    };
    tb.appendChild(tr);
  });
  body.appendChild(t);
  body.appendChild(hint(c.resV
    ? 'В ячейке: дальность до первого обрыва в среднем по направлениям, ниже — максимум и доля круга, где связь есть. «Обе» — по худшей линии. Нажмите строку — дрон встанет на эту высоту.'
    : 'В среднем — до первого обрыва по направлениям; площадь — доля круга, где связь есть. Нажмите строку — дрон встанет на эту высоту.'));
}

// ---------- плашка зоны поверх карты ----------

function createPill(): HTMLElement {
  const el = h(`<div id="covPill" class="cov-pill" hidden>
    <button type="button" class="cov-pill-main" title="Открыть зону покрытия"></button>
    <button type="button" class="cov-pill-x" title="Убрать зону с карты" aria-label="Убрать зону с карты">✕</button>
  </div>`);
  (el.querySelector('.cov-pill-main') as HTMLElement).onclick = () => openCoverageSheet();
  (el.querySelector('.cov-pill-x') as HTMLElement).onclick = () => clearCoverage();
  return el;
}

function renderPill() {
  const el = pill;
  if (!el) return;
  const c = shown;
  el.hidden = !c || !!sheetBody;
  if (!c || el.hidden) return;
  const main = el.querySelector('.cov-pill-main') as HTMLElement;
  main.innerHTML = '';
  const t = document.createElement('span');
  t.className = 'cov-pill-t';
  const sw = document.createElement('span');
  sw.className = 'cov-pill-lg';
  const { i } = heightIndex(c.heights, S.droneH);
  if (S.coverage.show === 'minh' && c.heights.length >= 2) {
    t.textContent = `Нужная высота · ${Math.round(c.heights[0])}–${hm(c.heights[c.heights.length - 1])}`;
    c.heights.forEach((_, k) => {
      const b = document.createElement('i');
      b.style.background = PALETTE[paletteIndex(k, c.heights.length, PALETTE.length)];
      sw.appendChild(b);
    });
  } else {
    const st = stats(c, lineOf(c, S.coverage.line))[i];
    t.textContent = `Дрон ${hm(c.heights[i])} · до ${fmtKm(st.median)}`;
    for (const s of ['ok', 'weak', 'none'] as const) {
      const b = document.createElement('b');
      b.className = `status-${s}`;
      b.textContent = ICON[s];
      sw.appendChild(b);
    }
  }
  main.append(t, sw);
  const note = running || c.prelim ? 'считаю…' : staleNote(c) ? 'устарела' : '';
  if (note) {
    const n = document.createElement('span');
    n.className = 'cov-pill-n';
    n.textContent = note;
    main.appendChild(n);
  }
  main.setAttribute('aria-label', `Зона покрытия: ${t.textContent}. Открыть`);
}
