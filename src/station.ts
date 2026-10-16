// Пульт (точка А): состояние и маркер, высота места с ревизией, радиопараметры с учётом местности,
// расчёт трассы пульт → точка (calcLink) и выбор пресета аппаратуры.
import maplibregl from 'maplibre-gl';
import { S, map, center, setGeo, fc, toast, openSheet, closeSheet, emit, on } from './app';
import { h } from './ui';
import { LatLon, distance, bearing } from './geo';
import { elevationAt, profile, demPlan } from './elevation';
import { analyzePair, minHeightForLink, LinkResult, PairResult, LineId, PRESETS, RadioParams } from './radio';
import { withClutter } from './clutter';
import { formatCoords } from './coords';
import { presetName, freqName, LineNeed } from './verdict';

/** Радиопараметры с учётом местности у пульта — их и нужно передавать в расчёт. */
export const effRadio = () => withClutter(S.radio, S.clutter);
/** То же для линии видео (местность у пульта общая для обеих линий). */
export const effVideo = () => withClutter(S.video.radio, S.clutter);
/** Видео для расчёта: null, если линия выключена. */
export const effVideoOrNull = (): RadioParams | null => (S.video.enabled ? effVideo() : null);

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

function renderStation() {
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
}

/**
 * Расчёт трассы пульт → target. null — пульта нет, его высота не загружена, точки совпадают
 * или пульт успели перенести, пока грузился профиль. При нехватке рельефа — DemMissingError.
 */
export async function calcLink(target: LatLon, radio: RadioParams = effRadio(), video: RadioParams | null = effVideoOrNull(), maxN = 600): Promise<LinkCalc | null> {
  if (!S.station || stationGround === null) return null;
  // Снимок входных данных: после await глобальное состояние могло измениться.
  const rev = stationRev, groundA = stationGround, antH = S.station.antH;
  const a = { lat: S.station.lat, lon: S.station.lon };
  const dist = distance(a, target);
  if (dist < 5) return null;
  const { z, step } = demPlan(a.lat, dist);
  const n = Math.max(16, Math.min(maxN, Math.round(dist / step)));
  const elev = await profile(a, target, n, z);
  if (rev !== stationRev) return null;
  elev[0] = groundA;
  const groundB = elev[n];
  const hA = groundA + antH;
  const pair = analyzePair(elev, dist, hA, droneAbs(groundB, S.droneH, groundA), radio, video);
  return { res: pair.rc, vres: pair.video, pair, elev, dist, az: bearing(a, target), target, groundA, groundB, antH, hA };
}

/** Высота дрона (в текущем режиме отсчёта) для трассы r: h → абсолютная высота над точкой цели. */
export const heightFnFor = (r: LinkCalc) => (hh: number) => droneAbs(r.groundB, hh, r.groundA);

/**
 * Нужная высота по каждой линии трассы r (radio/video — те же параметры, что дали r). Для строки связи и профиля:
 * «Управление — от 300 м · Видео 5,8 ГГц не добьёт».
 */
export function lineNeeds(r: LinkCalc, radio: RadioParams = effRadio(), video: RadioParams | null = r.vres ? effVideo() : null,
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
