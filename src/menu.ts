// Левое меню и настройки. Владелец: карточка 1C (docs/PLAN.md).
// С другими модулями общается только через S, emit, on из app.ts и публичные функции модулей.
import { S, $, h, map, center, toast, emit, on, field, BASES, applyMapStyle } from './app';
import { applyContours } from './contours';
import { saveNow, clearSaved, restoreProject, importText, toGeoJSON, toGPX, toKML, download } from './store';
import { PRESETS, RadioParams, budget, freeSpaceRange, radioHorizon } from './radio';
import { applyPreset, setStation, removeStation, stationGround, altModeText } from './link';
import { parseCoords, formatCoords, CoordFormat } from './coords';
import { distance, fmtDist } from './geo';
import { openMark } from './marks';
import { openCoverageSheet } from './coverage';
import { CLUTTER, clutterLoss, withClutter } from './clutter';

export type MenuSection = 'situation' | 'map' | 'calc' | 'files' | 'settings' | 'help';

const MAX_FILE = 20 * 1024 * 1024;
const REPO = 'https://github.com/Gornist/uavmap';
const ITEMS: { id: MenuSection; ico: string; title: string; sub: string }[] = [
  { id: 'situation', ico: '📍', title: 'Обстановка', sub: 'пульт, метки, маршруты, переход к координатам' },
  { id: 'map', ico: '🗺', title: 'Карта', sub: 'подложка, рельеф, подписи' },
  { id: 'calc', ico: '📡', title: 'Расчёт', sub: 'аппаратура, частоты, высоты, зона покрытия' },
  { id: 'files', ico: '📁', title: 'Файлы', sub: 'импорт, экспорт, резервная копия' },
  { id: 'settings', ico: '⚙', title: 'Настройки', sub: 'координаты, сброс' },
  { id: 'help', ico: '❓', title: 'Помощь', sub: 'как читать расчёт' },
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
    info.textContent = `${c.label}: ${c.rows.map(([k, v]) => `${k} ${v.replace(/<\/?em>/g, '')}`).join(' · ')} · рельеф: ${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}`;
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
    li.querySelector('small')!.textContent = fmtDist(len);
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

function calc(el: HTMLElement) {
  section(el, 'Аппаратура');
  const pl = h('<div class="list"></div>');
  for (const p of PRESETS) {
    const li = h(`<div class="li"${p.id === S.presetId ? ' style="border-color:var(--accent)"' : ''}><span class="t"></span><small></small></div>`);
    li.querySelector('.t')!.textContent = p.name;
    li.querySelector('small')!.textContent = p.note;
    li.addEventListener('click', () => { applyPreset(p.id); render(); });
    pl.appendChild(li);
  }
  el.appendChild(pl);
  if (S.presetId === 'custom') el.appendChild(h('<p class="hint">Параметры изменены вручную.</p>'));
  el.appendChild(h('<p class="hint">Пресеты ориентировочные — подставьте паспортные данные своей аппаратуры.</p>'));

  section(el, 'Параметры линии связи');
  const summary = h('<div class="kv"></div>');
  const upd = () => {
    const antH = S.station?.antH ?? 2;
    const eff = withClutter(S.radio, S.clutter);
    const bud = budget(eff), fs = freeSpaceRange(eff), hz = radioHorizon(antH, S.droneH, S.radio.k);
    summary.innerHTML = '';
    for (const [k, v] of [['Энергетический потенциал', `${bud.toFixed(1)} дБ`], ['Дальность в своб. пространстве', Number.isFinite(fs) ? fmtDist(fs) : '—'], ['Радиогоризонт', fmtDist(hz)]]) {
      const d = h('<div><small></small><b></b></div>');
      d.querySelector('small')!.textContent = k; d.querySelector('b')!.textContent = v;
      summary.appendChild(d);
    }
  };
  for (const f of RADIO_FIELDS) {
    const row = h(field(f.label, `<input type="number" inputmode="decimal" step="${f.step}">`));
    const inp = row.querySelector('input') as HTMLInputElement;
    inp.value = String(S.radio[f.key]);
    const hint = h('<p class="hint" style="margin:-4px 0 4px;text-align:right"></p>');
    const showHint = () => { hint.textContent = f.hint ? f.hint(S.radio[f.key]) : ''; hint.hidden = !f.hint; };
    showHint();
    inp.addEventListener('change', () => {
      const v = num(inp.value);
      if (!Number.isFinite(v) || v < f.min || v > f.max) { inp.value = String(S.radio[f.key]); toast(`${f.label}: от ${f.min} до ${f.max}`); return; }
      S.radio[f.key] = v; S.presetId = 'custom';
      fire('radio'); showHint(); upd();
    });
    el.append(row, hint);
  }

  section(el, 'Местность у пульта');
  const cseg = h('<div class="seg"></div>');
  for (const c of CLUTTER) {
    const b = button(c.name, S.clutter === c.id ? 'on' : '', () => { S.clutter = c.id; emit('radio'); render(); });
    b.title = c.hint;
    cseg.appendChild(b);
  }
  el.appendChild(cseg);
  const cur = CLUTTER.find((c) => c.id === S.clutter)!;
  const ch = h('<p class="hint"></p>');
  ch.textContent = `${cur.hint}: +${clutterLoss(S.clutter, S.radio.freqMHz).toFixed(1)} дБ на ${S.radio.freqMHz} МГц (по ITU-R P.833/P.2108; на низких частотах меньше). Складывается с ручными «потерями на местности».`;
  el.appendChild(ch);

  section(el, 'Высоты');
  const seg = h('<div class="seg"></div>');
  for (const [m, t] of [['takeoff', 'над точкой взлёта'], ['terrain', 'над рельефом']] as const) {
    seg.appendChild(button(t, S.altMode === m ? 'on' : '', () => { S.altMode = m; emit('radio'); render(); }));
  }
  el.appendChild(seg);
  const hn = h('<p class="hint"></p>');
  hn.textContent = `Сейчас: высота дрона ${altModeText()}.`;
  el.appendChild(hn);
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

  el.appendChild(h('<h4>Высоты для таблиц и зоны</h4>'));
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
  el.appendChild(chips);
  const add = h('<div class="row"><input type="number" inputmode="decimal" min="1" max="5000" placeholder="Новая высота, м" style="flex:3"></div>');
  const ai = add.querySelector('input') as HTMLInputElement;
  add.appendChild(button('Добавить', 'ghost', () => {
    const v = Math.round(num(ai.value));
    if (!Number.isFinite(v) || v < 1 || v > 5000) { toast('Высота: от 1 до 5000 м'); return; }
    if (S.coverage.heights.length >= 12) { toast('Не более 12 высот'); return; }
    if (!S.coverage.heights.includes(v)) S.coverage.heights = [...S.coverage.heights, v].sort((a, b) => a - b);
    ai.value = ''; fire('radio'); drawChips();
  }));
  el.appendChild(add);

  section(el, 'Итог');
  upd();
  el.appendChild(summary);
  el.appendChild(h('<p class="hint">Радиогоризонт — по высотам антенны пульта и дрона над землёй, без учёта рельефа.</p>'));
  el.appendChild(button('Зона покрытия…', 'primary', () => { close(); openCoverageSheet(); }));
}

// ---------- Файлы ----------

function files(el: HTMLElement) {
  section(el, 'Импорт');
  el.appendChild(h('<p class="hint">GeoJSON, GPX или KML (до 20 МБ): метки и маршруты добавятся к текущим.</p>'));
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
  el.appendChild(h('<p class="hint">Всё хранится только на этом устройстве. Копия — полный проект одним файлом.</p>'));
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
      '1. Наведите прицел на место пульта и нажмите «Проверить связь» → «Поставить пульт».',
      '2. Двигайте карту: строка внизу показывает запас связи до точки под прицелом.',
      '3. «Профиль» открывает разрез трассы с зоной Френеля и таблицы по высотам и аппаратуре.',
      '4. «Зона покрытия» (раздел «Расчёт») закрашивает карту по запасу связи.',
    ]],
    ['Запас в дБ', [
      'Запас — на сколько дБ принимаемый сигнал выше чувствительности приёмника.',
      'Не меньше желаемого запаса — связь уверенная. От 0 до желаемого — на грани, возможны срывы. Меньше 0 — связи нет.',
    ]],
    ['Зона Френеля', [
      'Радиоволна идёт не лучом, а «трубкой» вокруг линии визирования. Если препятствия закрывают более 40 % радиуса первой зоны Френеля, потери растут. Поэтому важно, чтобы свободными оставались не менее 60 %.',
    ]],
    ['Режимы высоты', [
      '«Над точкой взлёта» — высота дрона отсчитывается от рельефа под пультом, абсолютная высота полёта постоянна.',
      '«Над рельефом» — дрон повторяет рельеф, держа заданную высоту над землёй под собой.',
    ]],
    ['Ограничения модели', [
      'Учитываются свободное пространство, дифракция на рельефе (ITU-R P.526, метод Дейгу) и кривизна Земли с коэффициентом рефракции k.',
      'Не моделируются лес, здания, помехи, диаграммы направленности антенн и погода — для них задайте «потери на местности». Пресеты аппаратуры ориентировочные. Расчёт — оценка, а не гарантия связи.',
    ]],
    ['Источники данных', [
      'Рельеф: Mapzen Terrain Tiles (AWS Open Data). Снимки и подписи: Esri. Топокарта: OpenTopoMap, OpenStreetMap.',
    ]],
  ];
  for (const [t, ps] of blocks) {
    section(el, t);
    for (const s of ps) { const p = h('<p class="hint" style="font-size:13px"></p>'); p.textContent = s; el.appendChild(p); }
  }
}
