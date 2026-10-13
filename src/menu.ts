// Левое меню и настройки. Владелец: карточка 1C (docs/PLAN.md).
// С другими модулями общается только через S, emit, on из app.ts и публичные функции модулей.
import { S, $, h, map, center, toast, emit, on, field, BASES, applyMapStyle } from './app';
import { applyContours } from './contours';
import { saveNow, clearSaved, restoreProject, importText, toGeoJSON, toGPX, toKML, download } from './store';
import { presetsFor, RadioParams, LineId, budget, freeSpaceRange, radioHorizon } from './radio';
import { applyPreset, setStation, removeStation, stationGround, presetName, km } from './link';
import { parseCoords, formatCoords, CoordFormat } from './coords';
import { distance } from './geo';
import { openMark } from './marks';
import { openCoverageSheet } from './coverage';
import { CLUTTER, clutterLoss, withClutter } from './clutter';
import { openOfflineSheet } from './offline';
import { openMyMapsSheet } from './mymaps';
import { getTheme, setTheme, type ThemeChoice } from './theme';

export type MenuSection = 'situation' | 'map' | 'calc' | 'files' | 'settings' | 'help';

const MAX_FILE = 20 * 1024 * 1024;
const REPO = 'https://github.com/Gornist/uavmap';
const ITEMS: { id: MenuSection; ico: string; title: string; sub: string }[] = [
  { id: 'situation', ico: '📍', title: 'Обстановка', sub: 'пульт, метки, маршруты' },
  { id: 'map', ico: '🗺', title: 'Карта', sub: 'подложка, рельеф, подписи' },
  { id: 'calc', ico: '📡', title: 'Расчёт', sub: 'аппаратура, местность, высота' },
  { id: 'files', ico: '📁', title: 'Файлы', sub: 'офлайн, импорт, экспорт' },
  { id: 'settings', ico: '⚙', title: 'Настройки', sub: 'тема, координаты, сброс' },
  { id: 'help', ico: '❓', title: 'Помощь', sub: 'как пользоваться' },
];

let current: MenuSection | null = null;
let quiet = false; // свои правки не должны перерисовывать раздел (теряется фокус поля)

const isOpen = () => document.body.classList.contains('drawer-open');

function close() {
  document.body.classList.remove('drawer-open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

function fire(e: Parameters<typeof emit>[0]) {
  quiet = true;
  try { emit(e); } finally { quiet = false; }
}

export function initMenu(): void {
  $('btnMenu').addEventListener('click', () => openMenu());
  $('btnMenuTop').addEventListener('click', () => openMenu());
  $('drClose').addEventListener('click', close);
  $('scrim').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  for (const ev of ['station', 'radio', 'marks', 'routes'] as const) {
    on(ev, () => { if (isOpen() && current && !quiet) render(); });
  }
}

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
  const back = h('<button class="dr-back">‹ Назад</button>');
  back.addEventListener('click', () => { current = null; render(); });
  const sec = h('<div class="dr-sec"></div>');
  ({ situation, map: mapSection, calc, files, settings, help } as Record<MenuSection, (el: HTMLElement) => void>)[current](sec);
  body.append(back, sec);
  body.scrollTop = top;
}

function mainList() {
  const box = h('<div></div>');
  for (const it of ITEMS) {
    const b = h('<button class="dr-item"><span class="ico"></span><span><b></b><small></small></span></button>');
    b.querySelector('.ico')!.textContent = it.ico;
    b.querySelector('b')!.textContent = it.title;
    b.querySelector('small')!.textContent = it.sub;
    b.addEventListener('click', () => { current = it.id; render(); });
    box.appendChild(b);
  }
  return box;
}

const section = (el: HTMLElement, title: string) => { const t = h('<h4></h4>'); t.textContent = title; el.appendChild(t); };
const button = (text: string, cls: string, fn: () => void) => {
  const b = h(`<button class="${cls}"></button>`); b.textContent = text; b.addEventListener('click', fn); return b;
};
const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));

// ---------- Обстановка ----------

function situation(el: HTMLElement) {
  section(el, 'Пульт');
  const st = S.station;
  if (!st) {
    el.appendChild(h('<p class="hint">Пульт не поставлен. Наведите прицел на место и нажмите кнопку.</p>'));
    el.appendChild(h('<div class="row"></div>')).appendChild(button('Поставить в прицел', 'primary', () => { setStation(center()); }));
  } else {
    const c = formatCoords(st.lat, st.lon, S.coordFormat);
    const info = h('<p class="hint"></p>');
    info.textContent = `${c.label}: ${c.rows.map(([k, v]) => `${k} ${v.replace(/<\/?em>/g, '')}`).join(' · ')} · высота места: ${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}`;
    el.appendChild(info);
    const ant = h(field('Антенна над землёй, м', '<input type="number" inputmode="decimal" min="0" max="100" step="0.5">'));
    const inp = ant.querySelector('input') as HTMLInputElement;
    inp.value = String(st.antH);
    inp.addEventListener('change', () => {
      const v = num(inp.value);
      if (!Number.isFinite(v) || v < 0 || v > 100) { inp.value = String(st.antH); toast('Высота антенны: от 0 до 100 м'); return; }
      st.antH = v; fire('station');
    });
    el.appendChild(ant);
    const row = h('<div class="row"></div>');
    row.append(
      button('Показать', 'ghost', () => { close(); map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), 13) }); }),
      button('Поставить в прицел', 'ghost', () => { setStation(center()); }),
      button('Убрать', 'danger', () => removeStation()),
    );
    el.appendChild(row);
  }

  section(el, `Метки (${S.marks.length})`);
  const ml = h('<div class="list"></div>');
  if (!S.marks.length) el.appendChild(h('<p class="hint">Меток нет. Кнопка ✚⚑ внизу ставит метку в прицел.</p>'));
  for (const m of S.marks) {
    const li = h('<div class="li"><span class="dot"></span><span class="t"></span></div>');
    (li.querySelector('.dot') as HTMLElement).style.background = /^#[0-9a-fA-F]{3,8}$/.test(m.color) ? m.color : '#e3a948';
    li.querySelector('.t')!.textContent = m.name || 'Метка';
    li.addEventListener('click', () => { close(); map.flyTo({ center: [m.lon, m.lat], zoom: Math.max(map.getZoom(), 14) }); openMark(m.id); });
    ml.appendChild(li);
  }
  el.appendChild(ml);

  section(el, `Маршруты (${S.routes.length})`);
  if (!S.routes.length) el.appendChild(h('<p class="hint">Маршрутов нет. Нарисуйте линейкой и сохраните «В маршрут».</p>'));
  const rl = h('<div class="list"></div>');
  for (const r of S.routes) {
    let len = 0;
    for (let i = 1; i < r.pts.length; i++) len += distance({ lon: r.pts[i - 1][0], lat: r.pts[i - 1][1] }, { lon: r.pts[i][0], lat: r.pts[i][1] });
    const li = h('<div class="li"><span class="t"></span><small></small><button class="mini" title="Переименовать">✎</button><button class="mini" title="Удалить">🗑</button></div>');
    li.querySelector('.t')!.textContent = r.name || 'Маршрут';
    li.querySelector('small')!.textContent = km(len);
    li.addEventListener('click', () => {
      if (!r.pts.length) return;
      // Экстремумы циклом: spread по сотням тысяч точек превышает предел аргументов.
      let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
      for (const [lon, lat] of r.pts) { w = Math.min(w, lon); e = Math.max(e, lon); so = Math.min(so, lat); no = Math.max(no, lat); }
      close();
      map.fitBounds([[w, so], [e, no]], { padding: 60, maxZoom: 16 });
    });
    const [ren, del] = li.querySelectorAll('button');
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = prompt('Название маршрута', r.name);
      if (n === null) return;
      r.name = n.trim().slice(0, 120) || r.name; emit('routes');
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить маршрут «${r.name}»?`)) return;
      S.routes = S.routes.filter((x) => x.id !== r.id); emit('routes');
    });
    rl.appendChild(li);
  }
  el.appendChild(rl);

  section(el, 'Перейти к координатам');
  const go = h('<div class="row"><input type="text" placeholder="55.75 37.62 или X 6175000 Y 7412000" style="flex:3"></div>');
  const gi = go.querySelector('input') as HTMLInputElement;
  const doGo = () => {
    const p = parseCoords(gi.value);
    if (!p) { toast('Не понял координаты. Пример: 55.75 37.62 или X 6175000 Y 7412000'); return; }
    close(); map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14) });
  };
  gi.addEventListener('keydown', (e) => { if (e.key === 'Enter') doGo(); });
  go.appendChild(button('Перейти', 'primary', doGo));
  el.appendChild(go);
}

// ---------- Карта ----------

function mapSection(el: HTMLElement) {
  section(el, 'Подложка');
  const seg = h('<div class="seg"></div>');
  for (const [id, b] of Object.entries(BASES)) {
    const btn = button(b.name, id === S.map.base ? 'on' : '', () => { S.map.base = id; applyMapStyle(); render(); });
    seg.appendChild(btn);
  }
  el.appendChild(seg);
  const dim = h(field('Затемнение', '<input type="range" min="0" max="0.8" step="0.05">'));
  const di = dim.querySelector('input') as HTMLInputElement;
  di.value = String(S.map.dim);
  di.addEventListener('input', () => { S.map.dim = Math.min(0.8, Math.max(0, +di.value)); applyMapStyle(); });
  el.appendChild(dim);
  const chk = (label: string, key: 'hillshade' | 'contours' | 'labels') => {
    const c = h('<label class="chk"><input type="checkbox"><span></span></label>');
    c.querySelector('span')!.textContent = label;
    const i = c.querySelector('input') as HTMLInputElement;
    i.checked = S.map[key];
    i.addEventListener('change', () => { S.map[key] = i.checked; applyMapStyle(); applyContours(); });
    el.appendChild(c);
  };
  chk('Отмывка рельефа', 'hillshade');
  chk('Горизонтали', 'contours');
  chk('Подписи и дороги', 'labels');
  section(el, 'Данные');
  const a = h('<p class="hint"></p>');
  a.textContent = `Подложка: ${BASES[S.map.base]?.attr ?? ''}. Подписи и дороги: © Esri. Рельеф: Mapzen Terrain Tiles (AWS Open Data).`;
  el.appendChild(a);
}

// ---------- Расчёт ----------

const RADIO_FIELDS: { key: keyof RadioParams; label: string; min: number; max: number; step: string; hint?: (v: number) => string }[] = [
  { key: 'freqMHz', label: 'Частота, МГц', min: 1, max: 100000, step: '1' },
  { key: 'txPowerDbm', label: 'Мощность передатчика, дБм', min: -30, max: 60, step: '1', hint: (v) => `≈ ${+(10 ** (v / 10)).toPrecision(3)} мВт` },
  { key: 'txGainDbi', label: 'Усиление антенны пульта, дБи', min: -10, max: 50, step: '0.5' },
  { key: 'rxGainDbi', label: 'Усиление антенны дрона, дБи', min: -10, max: 50, step: '0.5' },
  { key: 'sensDbm', label: 'Чувствительность приёмника, дБм', min: -170, max: -30, step: '1' },
  { key: 'lossDb', label: 'Потери в тракте, дБ', min: 0, max: 60, step: '0.5' },
  { key: 'clutterDb', label: 'Потери на местности (лес, застройка), дБ', min: 0, max: 60, step: '1' },
  { key: 'fadeMarginDb', label: 'Желаемый запас, дБ', min: 0, max: 60, step: '1' },
  { key: 'k', label: 'Коэффициент рефракции k', min: 0.5, max: 3, step: '0.01' },
];

let calcTab: LineId = 'rc';
let advOpen = false; // «Для опытных» остаётся раскрытым при перерисовке раздела
const lineRadio = (line: LineId) => (line === 'rc' ? S.radio : S.video.radio);
const linePreset = (line: LineId) => (line === 'rc' ? S.presetId : S.video.presetId);
/** Подписи полей для видео: передатчик — на дроне, приёмник — на земле. */
const VIDEO_LABELS: Partial<Record<keyof RadioParams, string>> = {
  txPowerDbm: 'Мощность видеопередатчика, дБм',
  txGainDbi: 'Усиление антенны дрона (VTX), дБи',
  rxGainDbi: 'Усиление антенны приёма на земле, дБи',
};

function lineParams(el: HTMLElement, line: LineId, upd: () => void) {
  const R = lineRadio(line);
  for (const f of RADIO_FIELDS) {
    const label = (line === 'video' && VIDEO_LABELS[f.key]) || f.label;
    const row = h(field(label, `<input type="number" inputmode="decimal" step="${f.step}">`));
    const inp = row.querySelector('input') as HTMLInputElement;
    inp.value = String(R[f.key]);
    const hint = h('<p class="hint" style="margin:-4px 0 4px;text-align:right"></p>');
    const showHint = () => { hint.textContent = f.hint ? f.hint(R[f.key]) : ''; hint.hidden = !f.hint; };
    showHint();
    inp.addEventListener('change', () => {
      const v = num(inp.value);
      if (!Number.isFinite(v) || v < f.min || v > f.max) { inp.value = String(R[f.key]); toast(`${label}: от ${f.min} до ${f.max}`); return; }
      R[f.key] = v;
      if (line === 'rc') S.presetId = 'custom'; else S.video.presetId = 'custom';
      fire('radio'); showHint(); upd();
    });
    el.append(row, hint);
  }
}

function calc(el: HTMLElement) {
  // ----- аппаратура: два выпадающих списка с человеческими названиями -----
  section(el, 'Аппаратура');
  const presetSelect = (line: LineId, label: string) => {
    const row = h(field(label, '<select></select>'));
    row.classList.add('col'); // подпись над списком: названия аппаратуры длинные
    const sel = row.querySelector('select') as HTMLSelectElement;
    const add = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); };
    if (line === 'video') add('off', 'Не учитывать видео');
    for (const p of presetsFor(line)) add(p.id, presetName(p));
    if (linePreset(line) === 'custom') add('custom', 'Свои параметры (вручную)');
    sel.value = line === 'video' && !S.video.enabled ? 'off' : linePreset(line);
    sel.addEventListener('change', () => {
      if (sel.value === 'off') { S.video.enabled = false; emit('radio'); render(); return; }
      if (sel.value === 'custom') { if (line === 'video') { S.video.enabled = true; emit('radio'); } render(); return; }
      applyPreset(sel.value, line); render();
    });
    el.appendChild(row);
    const p = presetsFor(line).find((x) => x.id === linePreset(line));
    if (p && !(line === 'video' && !S.video.enabled)) {
      const n = h('<p class="hint muted"></p>'); n.textContent = p.note; el.appendChild(n);
    }
  };
  presetSelect('rc', 'Управление');
  presetSelect('video', 'Видео');

  section(el, 'Местность у пульта');
  const cseg = h('<div class="seg"></div>');
  for (const c of CLUTTER) {
    const b = button(c.name, S.clutter === c.id ? 'on' : '', () => { S.clutter = c.id; emit('radio'); render(); });
    b.title = c.hint;
    cseg.appendChild(b);
  }
  el.appendChild(cseg);
  const cur = CLUTTER.find((c) => c.id === S.clutter)!;
  const ch = h('<p class="hint muted"></p>');
  ch.textContent = `${cur.hint[0].toUpperCase()}${cur.hint.slice(1)}${clutterLoss(S.clutter, S.radio.freqMHz) ? ` — сигнал слабее на ${Math.round(clutterLoss(S.clutter, S.radio.freqMHz))} дБ` : ''}.`;
  el.appendChild(ch);

  section(el, 'Высота дрона');
  const seg = h('<div class="seg"></div>');
  for (const [m, t] of [['takeoff', 'Над точкой взлёта'], ['terrain', 'Над рельефом']] as const) {
    seg.appendChild(button(t, S.altMode === m ? 'on' : '', () => { S.altMode = m; emit('radio'); render(); }));
  }
  el.appendChild(seg);
  const dh = h(field('Высота дрона, м', '<input type="number" inputmode="decimal" min="0" max="5000" step="5">'));
  const di = dh.querySelector('input') as HTMLInputElement;
  di.value = String(S.droneH);
  di.addEventListener('change', () => {
    const v = num(di.value);
    if (!Number.isFinite(v) || v < 0 || v > 5000) { di.value = String(S.droneH); toast('Высота дрона: от 0 до 5000 м'); return; }
    S.droneH = v; fire('radio'); upd();
    const live = document.getElementById('inDrone') as HTMLInputElement | null;
    if (live) live.value = String(v);
  });
  el.appendChild(dh);

  el.appendChild(h('<div class="row"></div>')).appendChild(button('Зона покрытия…', 'primary', () => { close(); openCoverageSheet(); }));

  // ----- для опытных: числовые параметры линий, высоты для таблиц, итог -----
  const adv = document.createElement('details');
  adv.className = 'details';
  adv.open = advOpen;
  adv.addEventListener('toggle', () => { advOpen = adv.open; });
  const sum = document.createElement('summary');
  sum.textContent = 'Для опытных';
  adv.appendChild(sum);
  el.appendChild(adv);

  const summary = h('<div class="kv"></div>');
  const upd = () => {
    const antH = S.station?.antH ?? 2;
    const rc = withClutter(S.radio, S.clutter), vd = S.video.enabled ? withClutter(S.video.radio, S.clutter) : null;
    const hz = radioHorizon(antH, S.droneH, S.radio.k);
    const rng = (p: typeof rc) => km(freeSpaceRange(p));
    const rows: [string, string][] = vd
      ? [['Дальность без рельефа, упр. / видео', `${rng(rc)} / ${rng(vd)}`],
         ['Потенциал, упр. / видео', `${Math.round(budget(rc))} / ${Math.round(budget(vd))} дБ`],
         ['Радиогоризонт', km(hz)]]
      : [['Дальность без рельефа', rng(rc)], ['Энергетический потенциал', `${Math.round(budget(rc))} дБ`], ['Радиогоризонт', km(hz)]];
    summary.innerHTML = '';
    for (const [k, v] of rows) {
      const d = h('<div><small></small><b class="num"></b></div>');
      d.querySelector('small')!.textContent = k; d.querySelector('b')!.textContent = v;
      summary.appendChild(d);
    }
  };
  upd();
  adv.appendChild(summary);

  const tabs = h('<div class="seg"></div>');
  for (const [id, t] of [['rc', 'Управление'], ['video', 'Видео']] as const) {
    tabs.appendChild(button(t, calcTab === id ? 'on' : '', () => { calcTab = id; render(); }));
  }
  adv.appendChild(tabs);
  if (calcTab === 'video' && !S.video.enabled) adv.appendChild(h('<p class="hint">Видео не учитывается — выберите его в списке «Видео» выше.</p>'));
  else {
    if (linePreset(calcTab) === 'custom') adv.appendChild(h('<p class="hint">Параметры изменены вручную.</p>'));
    lineParams(adv, calcTab, upd);
    adv.appendChild(h('<p class="hint">Пресеты ориентировочные — подставьте паспортные данные своей аппаратуры.</p>'));
  }

  adv.appendChild(h('<h4>Высоты для таблиц и зоны</h4>'));
  const chips = h('<div class="chips"></div>');
  const drawChips = () => {
    chips.innerHTML = '';
    for (const hh of S.coverage.heights) {
      chips.appendChild(button(`${hh} м ✕`, '', () => {
        if (S.coverage.heights.length <= 1) { toast('Нужна хотя бы одна высота'); return; }
        S.coverage.heights = S.coverage.heights.filter((x) => x !== hh);
        S.coverage.heightIdx = Math.min(S.coverage.heightIdx, S.coverage.heights.length - 1);
        fire('radio'); drawChips();
      }));
    }
  };
  drawChips();
  adv.appendChild(chips);
  const add = h('<div class="row"><input type="number" inputmode="decimal" min="1" max="5000" placeholder="Новая высота, м" style="flex:3"></div>');
  const ai = add.querySelector('input') as HTMLInputElement;
  add.appendChild(button('Добавить', 'ghost', () => {
    const v = Math.round(num(ai.value));
    if (!Number.isFinite(v) || v < 1 || v > 5000) { toast('Высота: от 1 до 5000 м'); return; }
    if (S.coverage.heights.length >= 12) { toast('Не более 12 высот'); return; }
    if (!S.coverage.heights.includes(v)) S.coverage.heights = [...S.coverage.heights, v].sort((a, b) => a - b);
    ai.value = ''; fire('radio'); drawChips();
  }));
  adv.appendChild(add);
}

// ---------- Файлы ----------

function files(el: HTMLElement) {
  section(el, 'Офлайн');
  el.appendChild(h('<p class="hint">Скачайте рельеф района заранее — расчёт будет работать без сети.</p>'));
  const offRow = h('<div class="row"></div>');
  offRow.append(
    button('Офлайн-районы…', 'ghost', () => { close(); openOfflineSheet(); }),
    button('Свои карты…', 'ghost', () => { close(); openMyMapsSheet(); }),
  );
  el.appendChild(offRow);

  section(el, 'Импорт');
  el.appendChild(h('<p class="hint">GeoJSON, GPX или KML до 20 МБ — метки и маршруты добавятся к текущим.</p>'));
  el.appendChild(button('Импортировать файл…', 'primary', () => $('fileIn').click()));
  const fin = $('fileIn') as HTMLInputElement;
  fin.onchange = async () => {
    const f = fin.files?.[0];
    fin.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { toast('Файл слишком большой (больше 20 МБ)'); return; }
    try {
      const r = importText(await f.text(), f.name);
      // Без spread: у push(...arr) есть предел числа аргументов (большие файлы).
      for (const m of r.marks) S.marks.push(m);
      for (const rt of r.routes) S.routes.push(rt);
      emit('marks'); emit('routes');
      toast(`Добавлено: ${r.marks.length} меток, ${r.routes.length} маршрутов`);
    } catch (e) {
      toast(`Не удалось прочитать файл: ${e instanceof Error ? e.message : 'ошибка разбора'}`);
    }
  };

  section(el, 'Экспорт');
  const row = h('<div class="row"></div>');
  row.append(
    button('GeoJSON', 'ghost', () => download('uavmap.geojson', JSON.stringify(toGeoJSON(S), null, 1), 'application/geo+json')),
    button('GPX', 'ghost', () => download('uavmap.gpx', toGPX(S), 'application/gpx+xml')),
    button('KML', 'ghost', () => download('uavmap.kml', toKML(S), 'application/vnd.google-earth.kml+xml')),
  );
  el.appendChild(row);

  section(el, 'Резервная копия проекта');
  el.appendChild(h('<p class="hint">Всё хранится только на этом устройстве; копия — весь проект одним файлом.</p>'));
  const row2 = h('<div class="row"></div>');
  const d = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  row2.append(
    button('Сохранить копию', 'ghost', () => download(`uavmap-проект-${stamp}.json`, JSON.stringify(S), 'application/json')),
    button('Восстановить из копии…', 'ghost', () => bk.click()),
  );
  const bk = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  bk.onchange = async () => {
    const f = bk.files?.[0];
    bk.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { toast('Файл слишком большой (больше 20 МБ)'); return; }
    try {
      const st = restoreProject(await f.text());
      if (!confirm('Заменить текущий проект копией из файла?')) return;
      saveNow(st);
      location.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось прочитать копию');
    }
  };
  el.appendChild(row2);
}

// ---------- Настройки ----------

function settings(el: HTMLElement) {
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
  section(el, 'Проект');
  el.appendChild(button('Сбросить проект', 'danger', () => {
    if (!confirm('Удалить все метки, маршруты, пульт и настройки на этом устройстве?')) return;
    clearSaved();
    location.reload();
  }));
  section(el, 'О программе');
  const p = h('<p class="hint">Радиус — гражданская карта радиовидимости дрона. <a target="_blank" rel="noopener"></a></p>');
  const a = p.querySelector('a') as HTMLAnchorElement;
  a.href = REPO; a.textContent = REPO;
  el.appendChild(p);
}

// ---------- Помощь ----------

function help(el: HTMLElement) {
  const blocks: [string, string[]][] = [
    ['Как пользоваться', [
      '1. Наведите прицел на место пульта и нажмите «Проверить связь» — пульт встанет в прицел.',
      '2. Двигайте карту: внизу видно, будет ли связь с дроном над прицелом и на какой высоте.',
      '3. «Профиль» — разрез местности до прицела: что мешает и до какой высоты подняться.',
      '4. «Зона» закрашивает карту: зелёный — связь есть, жёлтый — на грани, красный — нет.',
    ]],
    ['Связь есть / на грани / нет', [
      'Линий две — управление и видео; итог считается по худшей. Видео обычно пропадает раньше.',
      '«Запас» — насколько сигнал сильнее минимально нужного (в дБ). Запас не меньше желаемого — связь есть; меньше — на грани, возможны срывы; ниже нуля — связи нет.',
    ]],
    ['Высота дрона', [
      '«Над точкой взлёта» — как показывает пульт: высота от земли у пульта.',
      '«Над рельефом» — дрон держит высоту над землёй под собой.',
    ]],
    ['Что не учитывается', [
      'Лес, здания, помехи, погода и направленность антенн. Для леса или посёлка у пульта выберите «Местность у пульта». Расчёт — оценка, а не гарантия связи.',
    ]],
    ['Источники данных', [
      'Рельеф: Mapzen Terrain Tiles (AWS Open Data). Снимки и подписи: Esri. Топокарта: OpenTopoMap, OpenStreetMap. Модель: ITU-R P.526-15.',
    ]],
  ];
  for (const [t, ps] of blocks) {
    section(el, t);
    for (const s of ps) { const p = h('<p class="hint"></p>'); p.textContent = s; el.appendChild(p); }
  }
}
