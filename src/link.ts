// Пульт (точка А), «связь до креста», профиль трассы и подбор места для пилота.
import maplibregl from 'maplibre-gl';
import { S, $, h, map, center, setGeo, fc, line, toast, openSheet, emit, on, progress, escapeHtml } from './app';
import { LatLon, distance, bearing, fmtDist, interpolate, lonLatToPixel, destination } from './geo';
import { elevationAt, profile, zoomForStep, fetchGrid, sampleGrid, DemMissingError, DemGrid } from './elevation';
import { analyzeLink, minHeightForLink, LinkResult, PRESETS, RadioParams, radioHorizon, freeSpaceRange } from './radio';
import { drawProfile } from './profileChart';
import { formatCoords } from './coords';

export let stationGround: number | null = null;
let stationMarker: maplibregl.Marker | null = null;

const STATUS_TXT = { ok: 'связь уверенная', weak: 'на грани', none: 'связи нет' } as const;
const STATUS_COL = { ok: '#4fbf72', weak: '#e3b948', none: '#e5484d' } as const;

export function altModeText() {
  return S.altMode === 'takeoff' ? 'над точкой взлёта' : 'над рельефом';
}

/** Абсолютная высота дрона над точкой с рельефом groundB. */
export function droneAbs(groundB: number, hDrone = S.droneH, groundA = stationGround ?? 0) {
  // Отрицательный рельеф не обрезаем: суша ниже уровня моря (Прикаспий) неотличима от батиметрии,
  // а ошибка над морем пессимистична (дрон ниже реального) — для оценки дальности это безопаснее.
  return (S.altMode === 'takeoff' ? groundA : groundB) + hDrone;
}

// Ревизия пульта: каждый перенос/удаление увеличивает её, и ответы,
// запрошенные для прежнего положения, отбрасываются.
let stationRev = 0;
export let stationGroundFailed = false;

async function loadStationGround() {
  const rev = ++stationRev;
  stationGround = null;
  stationGroundFailed = false;
  if (!S.station) return;
  const g = await elevationAt({ lat: S.station.lat, lon: S.station.lon });
  if (rev !== stationRev) return;
  stationGround = g;
  stationGroundFailed = g === null;
  if (stationGroundFailed) toast('Не удалось загрузить высоту пульта — нет данных рельефа');
  emit('station');
}

export async function setStation(p: LatLon, name = 'Пульт') {
  S.station = { lat: p.lat, lon: p.lon, antH: S.station?.antH ?? 2, name };
  const job = loadStationGround();
  renderStation();
  emit('station');
  await job;
}

/** Пульт, восстановленный из сохранённого проекта, — подгрузить его высоту. */
export function initStation() {
  renderStation();
  return loadStationGround();
}

export function removeStation() {
  S.station = null;
  stationRev++;
  stationGround = null;
  stationGroundFailed = false;
  renderStation();
  setGeo('link', fc());
  emit('station');
}

export function renderStation() {
  if (!S.station) { stationMarker?.remove(); stationMarker = null; return; }
  if (!stationMarker) {
    const el = h('<div class="station" title="Пульт">📡</div>');
    el.addEventListener('click', (e) => { e.stopPropagation(); showStationSheet(); });
    stationMarker = new maplibregl.Marker({ element: el }).setLngLat([S.station.lon, S.station.lat]).addTo(map);
  } else stationMarker.setLngLat([S.station.lon, S.station.lat]);
}

function showStationSheet() {
  if (!S.station) return;
  const st = S.station;
  const c = formatCoords(st.lat, st.lon, S.coordFormat);
  const b = openSheet('📡 Пульт — точка А', `
    <div class="kv">
      <div><small>Рельеф</small><b>${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}</b></div>
      <div><small>Антенна над землёй</small><b>${st.antH} м</b></div>
      <div><small>${c.label}</small><b>${c.short}</b></div>
    </div>
    <div class="row">
      <button class="ghost" id="stGo">Показать</button>
      <button class="ghost" id="stMove">Перенести в прицел</button>
      <button class="danger" id="stDel">Убрать пульт</button>
    </div>`);
  b.querySelector('#stGo')!.addEventListener('click', () => map.flyTo({ center: [st.lon, st.lat] }));
  b.querySelector('#stMove')!.addEventListener('click', () => { setStation(center()); toast('Пульт перенесён'); });
  b.querySelector('#stDel')!.addEventListener('click', () => {
    removeStation(); $('sheet').hidden = true;
  });
}

// ---------- Расчёт трассы ----------

export interface LinkCalc {
  res: LinkResult; elev: Float32Array; dist: number; az: number; target: LatLon;
  groundA: number; groundB: number; antH: number; hA: number;
}

/**
 * Расчёт трассы пульт → target. null — пульта нет, его высота не загружена, точки совпадают
 * или пульт успели перенести, пока грузился профиль. При нехватке рельефа — DemMissingError.
 */
export async function calcLink(target: LatLon, radio: RadioParams = S.radio): Promise<LinkCalc | null> {
  if (!S.station || stationGround === null) return null;
  // Снимок входных данных: после await глобальное состояние могло измениться.
  const rev = stationRev, groundA = stationGround, antH = S.station.antH;
  const a = { lat: S.station.lat, lon: S.station.lon };
  const dist = distance(a, target);
  if (dist < 5) return null;
  const step = Math.max(dist / 600, 15);
  const n = Math.max(16, Math.min(600, Math.round(dist / step)));
  const z = zoomForStep(a.lat, step);
  const elev = await profile(a, target, n, z);
  if (rev !== stationRev) return null;
  elev[0] = groundA;
  const groundB = elev[n];
  const hA = groundA + antH;
  const res = analyzeLink(elev, dist, hA, droneAbs(groundB, S.droneH, groundA), radio);
  return { res, elev, dist, az: bearing(a, target), target, groundA, groundB, antH, hA };
}

// ---------- Живая строка «связь до креста» ----------

let liveBusy = false, livePending = false;
export let lastLive: LinkCalc | null = null;

export async function updateLive() {
  if (!S.station) { setGeo('link', fc()); $('hereLink').hidden = true; return; }
  if (liveBusy) { livePending = true; return; }
  liveBusy = true;
  const st = $('lsStatus'), hl = $('hereLink');
  try {
    const c = center();
    let r: LinkCalc | null;
    try { r = await calcLink(c); } catch (e) {
      if (!(e instanceof DemMissingError)) throw e;
      lastLive = null;
      st.textContent = e.message; hl.hidden = true; setGeo('link', fc());
      return;
    }
    lastLive = r;
    if (!S.station) { setGeo('link', fc()); hl.hidden = true; return; }
    if (!r) {
      st.innerHTML = stationGroundFailed ? 'Нет данных рельефа под пультом' : stationGround === null ? 'Загружаю высоту пульта…' : 'Прицел на пульте — сдвиньте карту';
      setGeo('link', fc()); hl.hidden = true;
    } else {
      const { res } = r;
      const losTxt = res.belowGround ? 'дрон ниже рельефа' : res.los ? (res.minClearance >= 0.6 ? 'прямая видимость, Френель чист' : `прямая видимость, Френель закрыт на ${Math.round(Math.min(1, res.fresnelBlocked) * 100)}%`) : 'прямой видимости нет';
      st.innerHTML = `Аз. ${r.az.toFixed(1)}° · ${fmtDist(r.dist)} · запас <span class="${res.status}">${res.belowGround ? '—' : res.margin.toFixed(1) + ' дБ'}</span> · ${losTxt}`;
      hl.hidden = false;
      hl.innerHTML = `До пульта <b>${fmtDist(r.dist)}</b>, аз. <b>${r.az.toFixed(0)}°</b><br>Дрон ${S.droneH} м: <b style="color:${STATUS_COL[res.status]}">${STATUS_TXT[res.status]}</b> ${res.belowGround ? '(ниже рельефа)' : `(${res.margin.toFixed(0)} дБ)`}`;
      setGeo('link', fc([line([[S.station.lon, S.station.lat], [c.lon, c.lat]], { color: STATUS_COL[res.status], dash: res.los ? 0 : 1 })]));
    }
  } finally {
    liveBusy = false;
    if (livePending) { livePending = false; updateLive(); }
  }
}

// ---------- Полный профиль ----------

export async function showProfile(target = center()) {
  if (!S.station) { toast('Сначала поставьте пульт'); return; }
  if (stationGround === null) { toast(stationGroundFailed ? 'Нет данных рельефа под пультом' : 'Высота пульта ещё загружается'); return; }
  let r: LinkCalc | null;
  try { r = await calcLink(target); } catch (e) {
    if (e instanceof DemMissingError) { toast(e.message); return; }
    throw e;
  }
  if (!r) { if (S.station) toast('Прицел совпадает с пультом или пульт перенесён'); return; }
  renderProfileSheet(r);
}

function renderProfileSheet(r: LinkCalc) {
  const res = r.res, hA = r.hA;
  const st = { antH: r.antH };
  const absB = droneAbs(r.groundB, S.droneH, r.groundA);
  const heightFn = (hh: number) => droneAbs(r.groundB, hh, r.groundA);
  const minH = minHeightForLink(r.elev, r.dist, hA, heightFn, S.radio);
  const verdict = {
    ok: `Связь уверенная: запас ${res.margin.toFixed(1)} дБ при требуемых ${S.radio.fadeMarginDb} дБ`,
    weak: `На грани: запас ${res.margin.toFixed(1)} дБ — меньше желаемых ${S.radio.fadeMarginDb} дБ, возможны срывы`,
    none: `Связи нет: не хватает ${(-res.margin).toFixed(1)} дБ до чувствительности приёмника`,
  }[res.status];
  const verdictText = res.belowGround ? 'Связи нет: дрон ниже рельефа в этой точке — увеличьте высоту или переключите отсчёт «над рельефом»' : verdict;

  const heights = [...new Set([...S.coverage.heights, S.droneH])].sort((a, b) => a - b);
  const hRows = heights.map((hh) => {
    const m = analyzeLink(r.elev, r.dist, hA, heightFn(hh), S.radio);
    return `<tr data-h="${hh}" class="${hh === S.droneH ? 'sel' : ''}"><td>${hh} м</td><td>${Math.round(heightFn(hh))} м</td><td>${m.los ? 'да' : 'нет'}</td><td>${m.diffraction.toFixed(1)}</td><td style="color:${STATUS_COL[m.status]}">${m.margin.toFixed(1)}</td></tr>`;
  }).join('');

  const pRows = PRESETS.map((p) => {
    const radio = { ...S.radio, ...p.p };
    const m = analyzeLink(r.elev, r.dist, hA, absB, radio);
    const mh = minHeightForLink(r.elev, r.dist, hA, heightFn, radio);
    return `<tr data-p="${p.id}" class="${p.id === S.presetId ? 'sel' : ''}"><td>${p.name}</td><td>${radio.freqMHz}</td><td style="color:${STATUS_COL[m.status]}">${m.margin.toFixed(1)}</td><td>${mh === null ? '&gt;1500' : mh}</td></tr>`;
  }).join('');

  const hz = radioHorizon(st.antH, absB - r.groundB, S.radio.k);
  const b = openSheet(`Профиль: пульт → прицел · ${fmtDist(r.dist)}`, `
    <div class="verdict ${res.status}">${verdictText}</div>
    <canvas id="profileCanvas"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>линия визирования</span><span><i style="background:rgba(227,169,72,.35)"></i>1-я зона Френеля / 60 %</span><span><i style="background:var(--bad)"></i>перекрытие / препятствия</span></div>
    <div class="kv">
      <div><small>Азимут</small><b>${r.az.toFixed(1)}°</b></div>
      <div><small>Дрон абс. / над землёй</small><b>${Math.round(absB)} / ${Math.round(absB - r.groundB)} м</b></div>
      <div><small>Свободное пр-во</small><b>${res.fspl.toFixed(1)} дБ</b></div>
      <div><small>Дифракция на рельефе</small><b>${res.diffraction.toFixed(1)} дБ</b></div>
      <div><small>Уровень на приёме</small><b>${res.prx.toFixed(1)} дБм</b></div>
      <div><small>Запас</small><b style="color:${STATUS_COL[res.status]}">${res.belowGround ? '—' : res.margin.toFixed(1) + ' дБ'}</b></div>
      <div><small>Мин. зазор / Френель</small><b>${res.belowGround ? '—' : Math.round(res.minClearance * 100) + ' %'}</b></div>
      <div><small>Радиогоризонт</small><b>${fmtDist(hz)}</b></div>
      <div><small>Мин. высота для связи</small><b>${minH === null ? '&gt;1500 м' : minH + ' м'}</b></div>
      <div><small>Дальность без рельефа</small><b>${fmtDist(freeSpaceRange(S.radio))}</b></div>
    </div>
    <h4 class="hint">Высоты дрона (${altModeText()}) — нажмите строку, чтобы выбрать</h4>
    <table class="rt" id="tblH"><tr><th>Высота</th><th>Абс.</th><th>Видимость</th><th>Дифр., дБ</th><th>Запас, дБ</th></tr>${hRows}</table>
    <h4 class="hint">Аппаратура и частоты на высоте ${S.droneH} м — нажмите, чтобы применить</h4>
    <table class="rt" id="tblP"><tr><th>Пресет</th><th>МГц</th><th>Запас, дБ</th><th>Мин. высота, м</th></tr>${pRows}</table>
    <p class="hint">Расчёт: свободное пространство + дифракция на рельефе по ITU-R P.526 (метод Дейгу), k = ${S.radio.k.toFixed(2)}. Лес, здания, помехи и диаграммы антенн не моделируются — для них задайте «потери на местности» в разделе «Расчёт».</p>
  `);
  drawProfile(b.querySelector('#profileCanvas')!, res, { a: `А ${st.antH} м`, b: `Б ${Math.round(absB - r.groundB)} м` });
  b.querySelector('#tblH')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-h]') as HTMLElement | null;
    if (!tr) return;
    S.droneH = +tr.dataset.h!; ($('inDrone') as HTMLInputElement).value = String(S.droneH);
    emit('radio'); showProfile(r.target);
  });
  b.querySelector('#tblP')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-p]') as HTMLElement | null;
    if (!tr) return;
    applyPreset(tr.dataset.p!); showProfile(r.target);
  });
}

export function applyPreset(id: string) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  Object.assign(S.radio, p.p);
  S.presetId = id;
  emit('radio');
  toast(`Аппаратура: ${p.name}`);
}

// ---------- «Где встать»: лучшее место для пульта, чтобы дотянуться до прицела ----------

let bestMarkers: maplibregl.Marker[] = [];
export function clearBest() { bestMarkers.forEach((m) => m.remove()); bestMarkers = []; }

export async function findBestSpot(radius: number) {
  clearBest();
  const target = center();
  const antH = S.station?.antH ?? 2;
  const N = 20, cand: LatLon[] = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const dx = ((i / N) * 2 - 1) * radius, dy = ((j / N) * 2 - 1) * radius;
    const rr = Math.hypot(dx, dy);
    if (rr > radius) continue;
    cand.push(destination(target, (Math.atan2(dx, dy) * 180) / Math.PI, rr));
  }
  // Ищем место вокруг текущего пульта, если он есть, иначе — вокруг прицела (полёт «туда и обратно»).
  const base = S.station ? { lat: S.station.lat, lon: S.station.lon } : target;
  const around = cand.map((p) => destination(base, bearing(target, p), distance(target, p)));
  const far = Math.max(...around.map((p) => distance(p, target)));
  let z = zoomForStep(target.lat, Math.max(far / 250, 20));
  const tilesFor = (zz: number) => {
    const pts = [...around, target].map((p) => lonLatToPixel(p.lon, p.lat, zz));
    const xs = pts.map((p) => p[0] / 256), ys = pts.map((p) => p[1] / 256);
    return (Math.floor(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 1) * (Math.floor(Math.max(...ys)) - Math.floor(Math.min(...ys)) + 1);
  };
  while (z > 9 && tilesFor(z) > 49) z--;
  progress(0.2, 'Загружаю рельеф…');
  let grid: DemGrid;
  try { grid = await fetchGrid([...around, target], z); } catch (e) {
    progress(null);
    if (e instanceof DemMissingError) { toast(e.message); return; }
    throw e;
  }
  progress(0.6, 'Перебираю точки…');
  const at = (p: LatLon) => { const [x, y] = lonLatToPixel(p.lon, p.lat, z); return sampleGrid(grid, x, y); };
  const gT = at(target);
  const scored = around.map((p) => {
    const dist = distance(p, target);
    const n = Math.max(16, Math.min(250, Math.round(dist / 30)));
    const elev = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) elev[i] = at(interpolate(p, target, i / n));
    elev[n] = gT;
    const gA = elev[0];
    const res = analyzeLink(elev, Math.max(dist, 1), gA + antH, droneAbs(gT, S.droneH, gA), S.radio);
    return { p, res, gA, dist };
  }).sort((a, b) => b.res.margin - a.res.margin);
  const top: typeof scored = [];
  for (const s of scored) {
    if (top.every((t) => distance(t.p, s.p) > radius / 4)) top.push(s);
    if (top.length >= 5) break;
  }
  progress(null);
  top.forEach((t, i) => {
    const el = h(`<div class="mk" title="Вариант ${i + 1}" style="color:${STATUS_COL[t.res.status]}">◆<span class="mk-label">${i + 1}: ${t.res.margin.toFixed(0)} дБ</span></div>`);
    el.addEventListener('click', (e) => { e.stopPropagation(); setStation(t.p); clearBest(); toast('Пульт поставлен в выбранную точку'); });
    bestMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([t.p.lon, t.p.lat]).addTo(map));
  });
  const rows = top.map((t, i) => `<tr data-i="${i}"><td>${i + 1}</td><td>${Math.round(t.gA)} м</td><td>${fmtDist(t.dist)}</td><td>${t.res.los ? 'да' : 'нет'}</td><td style="color:${STATUS_COL[t.res.status]}">${t.res.margin.toFixed(1)}</td></tr>`).join('');
  const b = openSheet('Где встать пилоту', `
    <p class="hint">Лучшие точки в радиусе ${fmtDist(radius)} ${S.station ? 'от пульта' : 'от прицела'} для связи с дроном над прицелом на ${S.droneH} м (${altModeText()}), антенна ${antH} м. Нажмите строку или ромб на карте, чтобы перенести пульт.</p>
    <table class="rt"><tr><th>#</th><th>Рельеф</th><th>До прицела</th><th>Видимость</th><th>Запас, дБ</th></tr>${rows}</table>
    <div class="row"><button class="ghost" id="bsClear">Убрать варианты</button></div>`, clearBest);
  b.querySelector('table')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
    if (!tr) return;
    const t = top[+tr.dataset.i!];
    map.flyTo({ center: [t.p.lon, t.p.lat] });
    setStation(t.p);
  });
  b.querySelector('#bsClear')!.addEventListener('click', () => { clearBest(); $('sheet').hidden = true; });
}

on('station', () => { renderStation(); updateLive(); });
on('radio', () => updateLive());
export { escapeHtml };
