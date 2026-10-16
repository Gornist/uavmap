// «Где встать»: подбор места для пульта, откуда лучше связь с прицелом, — сразу в радиусе 1 км (можно 3 км),
// перебор точек на сетке рельефа, ромбы-варианты «1, 2, 3» на карте и таблица. Варианты без связи отсеиваются.
import maplibregl from 'maplibre-gl';
import { S, map, center, toast, openSheet, closeSheet, progress } from './app';
import { h } from './ui';
import { km, dB } from './format';
import { LatLon, distance, bearing, lonLatToPixel, destination } from './geo';
import { demPlan, demPixelM, fetchGrid, sampleGrid, sampleRay, DemMissingError, DemGrid } from './elevation';
import { analyzePair, RANK, PairResult } from './radio';
import { demTileCount } from './demTiles';
import { ICON, stCls, pairVerdict, statusCss } from './verdict';
import { setStation, effRadio, effVideoOrNull, droneAbs } from './station';
import { openOfflineSheet } from './offline';
import { directional } from './antenna';

/** Сколько вариантов показываем (ромбы «1, 2, 3»). */
const TOP_N = 3;

let bestMarkers: maplibregl.Marker[] = [];
function clearBest() { bestMarkers.forEach((m) => m.remove()); bestMarkers = []; }

let bestBusy = false;
/** Подбор места пульта (по умолчанию в 1 км); повторный запуск, пока идёт прежний, не начинается. */
export async function findBestSpot(radius = 1000) {
  if (bestBusy) { toast('Уже ищу место — подождите'); return; }
  bestBusy = true;
  try { await findBest(radius); } finally { bestBusy = false; progress(null); }
}

interface Spot { p: LatLon; pair: PairResult; dist: number }

async function findBest(radius: number) {
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
  const pts = [...around, target];
  const { z, step } = demPlan(target.lat, far, (zz) => demTileCount(pts, zz), 100);
  const pad = Math.ceil(step / demPixelM(target.lat, z)) + 2;
  progress(0.2, 'Загружаю рельеф…');
  let grid: DemGrid;
  try { grid = await fetchGrid(pts, z, pad); } catch (e) {
    progress(null);
    if (e instanceof DemMissingError) { noDem(); return; }
    throw e;
  }
  progress(0.6, 'Перебираю точки…');
  const [tx, ty] = lonLatToPixel(target.lon, target.lat, z);
  const gT = sampleGrid(grid, tx, ty);
  const rcEff = effRadio(), vEff = effVideoOrNull();
  const scored: Spot[] = around.map((p) => {
    const dist = distance(p, target);
    const n = Math.max(16, Math.min(400, Math.round(dist / step)));
    const ray = new Float64Array(n + 1), elev = new Float32Array(n + 1);
    sampleRay(grid, p.lat, p.lon, bearing(p, target), dist / n, n + 1, ray);
    elev.set(ray);
    elev[n] = gT;
    const gA = elev[0];
    const pair = analyzePair(elev, Math.max(dist, 1), gA + antH, droneAbs(gT, S.droneH, gA), rcEff, vEff);
    return { p, pair, dist };
  })
    // Без связи (и «дрон ниже склона» — тоже без связи) вариантом не считаем.
    .filter((s) => s.pair.status !== 'none' && !s.pair.rc.belowGround)
    // Сначала статус пары (обе линии есть > на грани), потом запас худшей линии сверх порога.
    .sort((a, b) => RANK[b.pair.status] - RANK[a.pair.status] || b.pair.score - a.pair.score);
  const top: Spot[] = [];
  for (const s of scored) {
    if (top.every((t) => distance(t.p, s.p) > radius / 4)) top.push(s);
    if (top.length >= TOP_N) break;
  }
  progress(null);
  if (!top.length) { nothingFound(radius); return; }
  showSpots(top, target, radius);
}

function noDem() {
  const b = openSheet('Где встать', '<p class="hint">Нет данных рельефа здесь — без них место не подобрать.</p><div class="row"><button class="primary" id="bsDl">Скачать район</button></div>');
  b.querySelector('#bsDl')!.addEventListener('click', () => openOfflineSheet());
}

function nothingFound(radius: number) {
  const wider = radius < 3000;
  const b = openSheet('Где встать', `<p class="verdict-why">В радиусе ${km(radius)} лучше не станет: ни из одной точки нет связи с прицелом на высоте ${S.droneH} м.</p>
    <p class="hint">Поднимите дрон (поле «Дрон» в строке связи) или ищите дальше.</p>
    <div class="row">${wider ? '<button class="primary" id="bsWide">Искать в 3 км</button>' : ''}<button class="ghost" id="bsClose">Закрыть</button></div>`);
  b.querySelector('#bsWide')?.addEventListener('click', () => { closeSheet(); findBestSpot(3000); });
  b.querySelector('#bsClose')!.addEventListener('click', closeSheet);
}

/**
 * Поставить пульт в вариант и вернуть прицел на цель — строка связи сразу покажет связь оттуда.
 * Варианты оценены с направленной антенной, смотрящей на цель (на новом месте пилот её так и поставит),
 * поэтому и направление антенн разворачиваем на цель — иначе строка связи сказала бы «вне луча».
 */
function choose(t: Spot, i: number, target: LatLon) {
  if (directional(S.antenna.rc) || directional(S.antenna.video)) S.antenna.heading = Math.round(bearing(t.p, target)) % 360;
  setStation(t.p);
  closeSheet(); // onClose шторки убирает ромбы
  map.flyTo({ center: [target.lon, target.lat] });
  toast(`Пульт поставлен в вариант ${i + 1}${directional(S.antenna.rc) || directional(S.antenna.video) ? `, антенны — на цель (${S.antenna.heading}°)` : ''}`);
}

function showSpots(top: Spot[], target: LatLon, radius: number) {
  const tEl = h('<div class="bs-mk bs-target" title="Цель — дрон над этой точкой"><span class="bs-label">цель</span></div>');
  bestMarkers.push(new maplibregl.Marker({ element: tEl }).setLngLat([target.lon, target.lat]).addTo(map));
  top.forEach((t, i) => {
    const el = h(`<div class="bs-mk" title="Вариант ${i + 1}: ${pairVerdict(t.pair)}" style="color:${statusCss(t.pair.status)}"><span class="bs-label">${i + 1}</span></div>`);
    el.addEventListener('click', (e) => { e.stopPropagation(); choose(t, i, target); });
    bestMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([t.p.lon, t.p.lat]).addTo(map));
  });
  const worst = (t: Spot) => (t.pair.worst === 'video' && t.pair.video ? t.pair.video : t.pair.rc);
  const rows = top.map((t, i) => `<tr><td class="num"><b>${i + 1}</b></td><td class="${stCls(t.pair.status)}">${ICON[t.pair.status]} ${pairVerdict(t.pair)}</td><td class="num">${km(t.dist)}</td><td class="num ${stCls(worst(t).status)}">${dB(worst(t).margin)}</td><td><button class="ghost apply" data-i="${i}">Встать</button></td></tr>`).join('');
  const b = openSheet('Где встать', `
    <p class="hint">Лучшие места в ${km(radius)} ${S.station ? 'от пульта' : 'от прицела'} для дрона над целью на ${S.droneH} м. Нажмите «Встать» или ромб на карте — пульт переедет туда.</p>
    <table class="rt rt-plain"><tr><th>#</th><th>Связь</th><th>До цели</th><th>Запас</th><th></th></tr>${rows}</table>
    <div class="row">${radius < 3000 ? '<button class="ghost" id="bsWide">Искать в 3 км</button>' : ''}<button class="ghost" id="bsClear">Убрать варианты</button></div>`, clearBest);
  b.querySelector('table')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-i]');
    if (btn) { const i = +btn.dataset.i!; choose(top[i], i, target); }
  });
  b.querySelector('#bsWide')?.addEventListener('click', () => { closeSheet(); findBestSpot(3000); });
  b.querySelector('#bsClear')!.addEventListener('click', closeSheet); // onClose шторки — clearBest
  fitSpots([target, ...top.map((t) => t.p)]);
}

/** Показать варианты и цель так, чтобы их не закрывала шторка (снизу на десктопе/портрете, слева в ландшафте). */
function fitSpots(pts: LatLon[]) {
  const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
  const bounds: [[number, number], [number, number]] = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  const cv = map.getContainer().getBoundingClientRect();
  const sh = document.getElementById('sheet')!.getBoundingClientRect();
  const pad = { top: 70, bottom: 90, left: 50, right: 70 };
  if (sh.width > cv.width * 0.6) pad.bottom = Math.max(pad.bottom, cv.bottom - sh.top + 24);
  else pad.left = Math.max(pad.left, sh.right - cv.left + 24);
  // Если места мало (низкий экран), уступаем отступы, но оставляем карте хотя бы 120 px.
  const fit = (a: number, b: number, size: number) => { const k = Math.min(1, (size - 120) / (a + b)); return [Math.max(0, a * k), Math.max(0, b * k)]; };
  [pad.top, pad.bottom] = fit(pad.top, pad.bottom, cv.height);
  [pad.left, pad.right] = fit(pad.left, pad.right, cv.width);
  map.fitBounds(bounds, { padding: pad, maxZoom: 15, duration: 600 });
}
