// Пульт (точка А): состояние и маркер, высота места с ревизией, радиопараметры с учётом местности,
// расчёт трассы пульт → точка (calcLink) и выбор пресета аппаратуры.
import maplibregl from 'maplibre-gl';
import { S, map, center, setGeo, fc, toast, openSheet, closeSheet, emit, on } from './app';
import { h } from './ui';
import { LatLon, distance, bearing, destination } from './geo';
import { elevationAt, profile, demPlan } from './elevation';
import { analyzePair, minHeightForLink, LinkResult, PairResult, LineId, PRESETS, RadioParams } from './radio';
import { withClutter } from './clutter';
import { directional, patternLoss } from './antenna';
import { formatCoords } from './coords';
import { presetName, freqName, LineNeed } from './verdict';

/**
 * Антенна на земле в радиопараметрах линии: у направленной усиление наземной стороны (у управления — передатчик
 * пульта, у видео — приёмник) — по диаграмме в направлении az; без az — пиковое (антенна смотрит на цель).
 */
export function aimAt(p: RadioParams, line: LineId, az?: number): RadioParams {
  const a = S.antenna[line];
  if (!directional(a)) return p;
  const g = a.gainDbi + (az === undefined ? 0 : patternLoss(a, az, S.antenna.heading));
  return line === 'rc' ? { ...p, txGainDbi: g } : { ...p, rxGainDbi: g };
}

/** Радиопараметры с учётом местности и антенны у пульта (az — направление на цель) — их и нужно передавать в расчёт. */
export const effRadio = (az?: number) => aimAt(withClutter(S.radio, S.clutter), 'rc', az);
/** То же для линии видео (местность у пульта общая для обеих линий). */
export const effVideo = (az?: number) => aimAt(withClutter(S.video.radio, S.clutter), 'video', az);
/** Видео для расчёта: null, если линия выключена. */
export const effVideoOrNull = (az?: number): RadioParams | null => (S.video.enabled ? effVideo(az) : null);

export let stationGround: number | null = null;
let stationMarker: maplibregl.Marker | null = null;

/**
 * Высота дрона везде одна — над точкой взлёта (у пульта), как барометр показывает её в очках и на пульте.
 * Над землёй под дроном она меньше на подъём склона: это видно полосой «склон» на высотомере и в вердикте.
 */
export const ALT_TEXT = 'над точкой взлёта';

/** Абсолютная высота дрона (над уровнем моря) для точки с рельефом groundB: groundB не влияет — высота от взлёта. */
export function droneAbs(_groundB: number, hDrone = S.droneH, groundA = stationGround ?? 0) {
  // Отрицательный рельеф не обрезаем: суша ниже уровня моря (Прикаспий) неотличима от батиметрии,
  // а ошибка над морем пессимистична (дрон ниже реального) — для оценки дальности это безопаснее.
  return groundA + hDrone;
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

/** Луч направленной антенны у пульта: сектор шириной луча (по −3 дБ) на 2,5 км — видно, куда «смотрит» пульт. */
const AIM_R = 2500;
function renderAim() {
  if (!map.getSource('aim')) {
    // Стиль ещё не готов (карта только создаётся) — дорисуем, когда успокоится.
    try { map.addSource('aim', { type: 'geojson', data: fc() }); } catch { map.once('idle', renderAim); return; }
    const before = map.getStyle().layers.find((l) => l.id.startsWith('ov-'))?.id;
    map.addLayer({ id: 'aim-fill', type: 'fill', source: 'aim', paint: { 'fill-color': '#d9a446', 'fill-opacity': 0.14 } }, before);
    map.addLayer({ id: 'aim-line', type: 'line', source: 'aim', paint: { 'line-color': '#d9a446', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 } }, before);
  }
  const st = S.station;
  const feats: GeoJSON.Feature[] = [];
  const lines = (['rc', 'video'] as const).filter((l) => directional(S.antenna[l]) && (l === 'rc' || S.video.enabled));
  const beams = [...new Set(lines.map((l) => S.antenna[l].beamDeg))]; // одинаковые лучи — один сектор
  if (st) for (const beam of beams) {
    const pts: [number, number][] = [[st.lon, st.lat]];
    for (let a = -beam / 2; a <= beam / 2 + 1e-9; a += Math.max(1, beam / 30)) {
      const p = destination(st, S.antenna.heading + a, AIM_R);
      pts.push([p.lon, p.lat]);
    }
    pts.push([st.lon, st.lat]);
    feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} });
  }
  setGeo('aim', fc(feats));
}

function renderStation() {
  renderAim();
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
  const b = openSheet('📡 Пульт', `
    <div class="kv">
      <div><small>Рельеф</small><b>${stationGround !== null ? Math.round(stationGround) + ' м' : '…'}</b></div>
      <div><small>${c.label}</small><b>${c.short}</b></div>
    </div>
    <label class="field st-ant"><span>Антенна над землёй, м</span><input id="stAnt" type="text" inputmode="decimal" value="${st.antH}"></label>
    <div class="row">
      <button class="ghost" id="stGo">Показать</button>
      <button class="ghost" id="stMove">Пульт сюда</button>
      <button class="danger" id="stDel">Убрать пульт</button>
    </div>`);
  // Антенна пульта: 0–100 м; неверное значение откатывается с подсказкой.
  const ant = b.querySelector('#stAnt') as HTMLInputElement;
  const parseAnt = () => { const v = parseFloat(ant.value.replace(',', '.')); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null; };
  ant.addEventListener('input', () => { const v = parseAnt(); if (v !== null && S.station && v !== S.station.antH) { S.station.antH = v; emit('station'); } });
  ant.addEventListener('change', () => { if (parseAnt() === null) { ant.value = String(S.station?.antH ?? 2); toast('Антенна: от 0 до 100 м'); } });
  b.querySelector('#stGo')!.addEventListener('click', () => map.flyTo({ center: [st.lon, st.lat] }));
  b.querySelector('#stMove')!.addEventListener('click', () => { setStation(center()); toast('Пульт перенесён в прицел'); });
  b.querySelector('#stDel')!.addEventListener('click', () => {
    removeStation(); closeSheet();
  });
}

// ---------- Расчёт трассы ----------

export interface LinkCalc {
  res: LinkResult;            // линия «Управление»
  vres: LinkResult | null;    // линия «Видео» (null — выключена)
  pair: PairResult;
  elev: Float32Array; dist: number; az: number; target: LatLon;
  groundA: number; groundB: number; antH: number; hA: number;
  /** Радиопараметры, с которыми посчитана трасса (местность и антенна в направлении на цель). */
  rp: RadioParams; vp: RadioParams | null;
}

/**
 * Расчёт трассы пульт → target. null — пульта нет, его высота не загружена, точки совпадают
 * или пульт успели перенести, пока грузился профиль. При нехватке рельефа — DemMissingError.
 */
export async function calcLink(target: LatLon, maxN = 600): Promise<LinkCalc | null> {
  if (!S.station || stationGround === null) return null;
  // Снимок входных данных: после await глобальное состояние могло измениться.
  const rev = stationRev, groundA = stationGround, antH = S.station.antH;
  const a = { lat: S.station.lat, lon: S.station.lon };
  const dist = distance(a, target);
  if (dist < 5) return null;
  const az = bearing(a, target);
  // Снимок радиопараметров до await (с антенной в направлении на цель).
  const radio = effRadio(az), video = effVideoOrNull(az);
  const { z, step } = demPlan(a.lat, dist);
  const n = Math.max(16, Math.min(maxN, Math.round(dist / step)));
  const elev = await profile(a, target, n, z);
  if (rev !== stationRev) return null;
  elev[0] = groundA;
  const groundB = elev[n];
  const hA = groundA + antH;
  const pair = analyzePair(elev, dist, hA, droneAbs(groundB, S.droneH, groundA), radio, video);
  return { res: pair.rc, vres: pair.video, pair, elev, dist, az, target, groundA, groundB, antH, hA, rp: radio, vp: video };
}

/** Высота дрона (в текущем режиме отсчёта) для трассы r: h → абсолютная высота над точкой цели. */
export const heightFnFor = (r: LinkCalc) => (hh: number) => droneAbs(r.groundB, hh, r.groundA);

/**
 * Нужная высота по каждой линии трассы r (radio/video — те же параметры, что дали r). Для строки связи и профиля:
 * «Управление — от 300 м · Видео 5,8 ГГц не добьёт».
 */
export function lineNeeds(r: LinkCalc, radio: RadioParams = r.rp, video: RadioParams | null = r.vp,
  known?: { rc: number | null; video: number | null }): LineNeed[] {
  const fn = heightFnFor(r);
  const need = (p: RadioParams) => minHeightForLink(r.elev, r.dist, r.hA, fn, p);
  const out: LineNeed[] = [{ name: 'Управление', need: known ? known.rc : need(radio), status: r.res.status }];
  if (r.vres && video) out.push({ name: `Видео ${freqName(video.freqMHz)}`, need: known ? known.video : need(video), status: r.vres.status });
  return out;
}

/** Применить пресет к линии (по умолчанию: видео-пресеты — к видео, остальные — к управлению). */
export function applyPreset(id: string, line?: LineId) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  const ln: LineId = line ?? (p.kind === 'video' ? 'video' : 'rc');
  if (ln === 'video') { Object.assign(S.video.radio, p.p); S.video.presetId = id; S.video.enabled = true; }
  else { Object.assign(S.radio, p.p); S.presetId = id; }
  emit('radio');
  toast(`${ln === 'video' ? 'Видео' : 'Управление'}: ${presetName(p)}`);
}

// Маркер пульта — до живой строки (live.ts подписывается на 'station' следом).
on('station', () => renderStation());
// Луч антенны зависит и от радио (видео включили/выключили).
on('radio', () => renderAim());
