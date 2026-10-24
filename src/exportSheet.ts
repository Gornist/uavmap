// Экспорт: картинка карты (JPEG) с зоной, пультом и метками и лист для печати — карта, профиль до прицела, таблица
// связи и аппаратуры. Отдельный чанк (грузится по кнопке в меню «Метки и файлы»).
import maplibregl from 'maplibre-gl';
import { S, map, toast } from './app';
import { download } from './store';
import { km, dB, escapeHtml } from './format';
import { toSK42 } from './coords';
import { distance } from './geo';
import { minHeightsForPair, PRESETS, LinkResult } from './radio';
import { ICON, stCls, pairVerdict, presetName, freqName, needLinesHtml } from './verdict';
import { calcLink, stationGround, heightFnFor, lineNeeds, droneAbs, ALT_TEXT, activeAntennaLines, LinkCalc } from './station';
import { ANTENNA_TYPES, rumb } from './antenna';
import { drawProfile } from './profileChart';
import { DemMissingError } from './elevation';
import { BEAM_COLOR, LINE_TITLE } from './antennaUi';
import { STATUS_MAP } from './theme';
import { coverageOnMap, coverageFill, PALETTE } from './coverageView';
import './styles/print.css';

const p2 = (n: number) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const human = (d = new Date()) => `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

/** Аппаратура линии словами: название пресета (если выбран) и частота. */
function gear(line: 'rc' | 'video'): string {
  const id = line === 'rc' ? S.presetId : S.video.presetId;
  const p = PRESETS.find((x) => x.id === id);
  const f = (line === 'rc' ? S.radio : S.video.radio).freqMHz;
  return p ? `${presetName(p)} (${f} МГц)` : `${freqName(f)} (${f} МГц)`;
}

const sk42 = (lat: number, lon: number) => { const { x, y } = toSK42(lat, lon); return `X ${x} Y ${y}`; };
const wgs = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
/** Подписи источников карты (обязательны и на картинке): из блока атрибуции карты. */
const attribution = () => (document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || '').replace(/\s+/g, ' ').trim();

// ---------- Картинка карты ----------

/** Кадр карты и всё, что от камеры зависит, — в один момент (пока ждём тайлы, карту могут сдвинуть). */
interface Frame {
  canvas: HTMLCanvasElement;
  /** Пиксели холста для точки — по камере этого кадра. */
  px: (lon: number, lat: number) => [number, number];
  target: { lat: number; lon: number };
  lat: number; zoom: number;
}

/**
 * Кадр карты: WebGL-холст без preserveDrawingBuffer читается только сразу после отрисовки кадра, поэтому
 * копируем его в обработчике 'render' (перерисовку просим сами). Подложки и рельеф приходят с CORS — холст не «грязный».
 * Там же запоминаем камеру: точки пульта и меток проецируются по ней, а не по текущей.
 */
async function grabMap(): Promise<Frame> {
  // Тайлы ещё грузятся — дождаться (не дольше 8 с), иначе на картинке будут пустые квадраты.
  if (!map.areTilesLoaded()) await new Promise<void>((r) => { const t = setTimeout(r, 8000); map.once('idle', () => { clearTimeout(t); r(); }); });
  return new Promise((resolve) => {
    const src = map.getCanvas();
    const out = document.createElement('canvas');
    map.once('render', () => {
      out.width = src.width; out.height = src.height;
      out.getContext('2d')!.drawImage(src, 0, 0);
      const k = src.width / src.clientWidth; // пиксели холста на CSS-пиксель
      const tr = map.transform.clone();
      const c = map.getCenter();
      resolve({
        canvas: out,
        px: (lon, lat) => { const p = tr.locationPoint(new maplibregl.LngLat(lon, lat)); return [p.x * k, p.y * k]; },
        target: { lat: c.lat, lon: c.lng }, lat: c.lat, zoom: map.getZoom(),
      });
    });
    map.triggerRepaint();
  });
}

/** Круглая длина масштабной линейки ~ want м: 1, 2, 5 × 10ⁿ. */
function niceLen(want: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(want)));
  return [1, 2, 5, 10].map((k) => k * e).filter((v) => v <= want).pop() ?? e;
}

/** Текст с тёмной обводкой — читается на любой подложке. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#fff') {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/**
 * Карта с подписями поверх и полосой сведений снизу: пульт, метки, прицел (если пульт стоит), масштаб, легенда
 * границ радиогоризонта, высота дрона, аппаратура, дата и источники карты.
 */
export async function composeMap(): Promise<{ canvas: HTMLCanvasElement; target: { lat: number; lon: number } }> {
  const f = await grabMap();
  const base = f.canvas;
  const k = base.width / map.getCanvas().clientWidth; // пиксели холста на CSS-пиксель
  const W = base.width;
  const foot = layoutFooter(f, k, W);
  const footH = foot.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = base.height + footH;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const px = f.px;
  const inside = ([x, y]: number[]) => x >= 0 && y >= 0 && x <= W && y <= base.height;

  // Метки
  ctx.font = `600 ${Math.round(12 * k)}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const m of S.marks) {
    const p = px(m.lon, m.lat);
    if (!inside(p)) continue;
    ctx.beginPath(); ctx.arc(p[0], p[1], 5 * k, 0, Math.PI * 2);
    ctx.fillStyle = /^#[0-9a-fA-F]{3,8}$/.test(m.color) ? m.color : '#e0a530';
    ctx.fill(); ctx.lineWidth = 1.5 * k; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.lineWidth = 3 * k;
    label(ctx, m.name || 'Метка', p[0] + 9 * k, p[1]);
  }
  // Пульт и прицел
  const st = S.station;
  if (st) {
    const p = px(st.lon, st.lat);
    if (inside(p)) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 9 * k, 0, Math.PI * 2);
      ctx.fillStyle = '#d9a446'; ctx.fill(); ctx.lineWidth = 2.5 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 3 * k;
      label(ctx, 'Пульт', p[0] + 13 * k, p[1]);
    }
    const c = f.target;
    if (distance(st, c) > 5) {
      const [x, y] = px(c.lon, c.lat), r = 9 * k;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'; ctx.lineWidth = 4 * k;
      const cross = () => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - 2 * r, y); ctx.lineTo(x - r / 2, y); ctx.moveTo(x + r / 2, y); ctx.lineTo(x + 2 * r, y); ctx.moveTo(x, y - 2 * r); ctx.lineTo(x, y - r / 2); ctx.moveTo(x, y + r / 2); ctx.lineTo(x, y + 2 * r); ctx.stroke(); };
      cross(); ctx.strokeStyle = '#e0a530'; ctx.lineWidth = 2 * k; cross();
    }
  }

  // Полоса сведений (разметка — layoutFooter: строки переносятся по словам, легенда — по рядам)
  const y0 = base.height;
  ctx.fillStyle = '#171614'; ctx.fillRect(0, y0, W, footH);
  ctx.textBaseline = 'top';
  const b = foot.bar;
  ctx.fillStyle = '#fff';
  ctx.fillRect(b.x, y0 + b.y, b.w, 3 * k); ctx.fillRect(b.x, y0 + b.y - 4 * k, 2 * k, 7 * k); ctx.fillRect(b.x + b.w - 2 * k, y0 + b.y - 4 * k, 2 * k, 7 * k);
  ctx.font = font(600, 12, k);
  ctx.fillText(b.text, b.x, y0 + b.y + 7 * k);
  for (const t of foot.texts) { ctx.font = t.font; ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, y0 + t.y); }
  for (const e of foot.legend) {
    ctx.fillStyle = e.color; ctx.fillRect(e.x, y0 + e.y + 5 * k, 18 * k, 4 * k);
    ctx.font = font(400, 12, k); ctx.fillStyle = '#ddd'; ctx.fillText(e.text, e.x + 23 * k, y0 + e.y);
  }
  return { canvas: out, target: f.target };
}

const font = (w: number, size: number, k: number) => `${w} ${Math.round(size * k)}px system-ui, sans-serif`;

/** Перенос по словам в ширину maxW (шрифт уже выставлен в ctx). */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(' ')) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Разметка полосы сведений под картой (координаты от её верха): масштаб справа вверху, строки сведений — с переносом
 * по словам левее него, легенда — рядами во всю ширину. На узком экране телефона ничего не уходит за край картинки.
 */
function layoutFooter(f: Frame, k: number, W: number) {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const pad = 14 * k, padY = Math.round(10 * k), lh = Math.round(16 * k);
  // Масштаб: метров на CSS-пиксель в центре кадра (тайлы MapLibre — 512 px).
  const mPerPx = (40075016.686 * Math.cos((f.lat * Math.PI) / 180)) / (512 * Math.pow(2, f.zoom));
  const len = niceLen(Math.min(120, W / k / 4) * mPerPx), barW = (len / mPerPx) * k;
  const bar = { x: W - barW - pad, y: padY + 4 * k, w: barW, text: km(len) };
  const textW = bar.x - 2 * pad;
  const texts: { text: string; x: number; y: number; font: string; color: string }[] = [];
  let y = padY;
  footerLines().forEach((line, i) => {
    const fnt = font(i === 0 ? 700 : 400, i === 0 ? 13 : 12, k);
    ctx.font = fnt;
    for (const t of wrap(ctx, line, textW)) { texts.push({ text: t, x: pad, y, font: fnt, color: i === 3 ? '#a8a29a' : '#fff' }); y += lh; }
  });
  y = Math.max(y, bar.y + 7 * k + lh);
  const items: { color: string; text: string; x: number; y: number }[] = [];
  ctx.font = font(400, 12, k);
  let x = pad;
  const rows = legend();
  if (rows.length) y += 4 * k;
  for (const [color, text] of rows) {
    const w = 23 * k + ctx.measureText(text).width;
    if (x > pad && x + w > W - pad) { x = pad; y += lh; }
    items.push({ color, text, x, y });
    x += w + 16 * k;
  }
  if (rows.length) y += lh;
  return { height: Math.round(y + padY), bar, texts, legend: items };
}

function legend(): [string, string][] {
  const c = coverageOnMap();
  if (!c) return [];
  const out: [string, string][] = [];
  const both = !!c.resV; // границы рисуются обе, если видео посчитано (coverageView.ts, drawEdge)
  out.push([BEAM_COLOR.rc, both ? `граница управления (дрон ${S.droneH} м)` : `граница связи (дрон ${S.droneH} м)`]);
  if (both) out.push([BEAM_COLOR.video, 'граница видео']);
  if (coverageFill()) {
    if (S.coverage.show === 'minh' && c.heights.length >= 2) out.push([PALETTE[0], 'заливка — нужная высота: светлее — ниже']);
    else out.push([STATUS_MAP.ok, 'связь есть'], [STATUS_MAP.weak, 'на грани'], [STATUS_MAP.none, 'нет']);
  }
  return out;
}

/** Картинка в JPEG: спутниковая подложка в PNG весит мегабайты (2048 px — ~5 МБ против ~1 МБ). */
const JPEG_Q = 0.9;

function footerLines(): string[] {
  const st = S.station;
  const head = `Радиус · ${human()} · дрон ${S.droneH} м ${ALT_TEXT}`;
  const gearLine = `Управление: ${gear('rc')}${S.video.enabled ? ` · видео: ${gear('video')}` : ''}`;
  const stLine = st ? `Пульт: СК-42 ${sk42(st.lat, st.lon)} · WGS-84 ${wgs(st.lat, st.lon)} · антенна ${st.antH} м${stationGround !== null ? ` · рельеф ${Math.round(stationGround)} м` : ''}` : 'Пульт не поставлен';
  return [head, stLine, gearLine, `Оценка по рельефу${S.forest.on ? ' и лесу' : ''}, не гарантия. ${attribution()}`];
}

/** Сохранить картинку карты в файл. */
export async function exportImage(): Promise<void> {
  try {
    const cv = (await composeMap()).canvas;
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', JPEG_Q));
    if (!blob) throw new Error('jpeg');
    download(`uavmap-карта-${stamp()}.jpg`, blob, 'image/jpeg');
  } catch {
    toast('Не удалось сохранить картинку карты', 4000);
  }
}

// ---------- Лист для печати ----------

/** Профиль трассы картинкой: холст вне экрана нужного размера, цвета дневной темы — на бумаге белый фон. */
function profileImage(res: LinkResult, labels: { a: string; b: string }): string {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:280px';
  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:900px;height:280px;display:block';
  box.appendChild(cv);
  document.body.appendChild(box);
  const root = document.documentElement, was = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'day');
  try {
    drawProfile(cv, res, labels);
    return cv.toDataURL('image/png');
  } finally {
    if (was === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', was);
    box.remove();
  }
}

const row = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
const margin = (x: LinkResult) => `<span class="${stCls(x.status)}">${x.belowGround ? '—' : dB(x.margin)}</span>`;

/** Блок «до прицела»: вердикт, нужные высоты, профиль, таблица трассы. */
function linkBlock(r: LinkCalc): string {
  const fn = heightFnFor(r);
  const mins = minHeightsForPair(r.elev, r.dist, r.hA, fn, r.rp, r.vp);
  const absB = droneAbs(r.groundB, S.droneH, r.groundA);
  const agl = absB - r.groundB;
  const img = profileImage(r.res, { a: `Пульт ${r.antH} м`, b: agl < 0 ? 'Дрон ниже склона' : `Дрон ${Math.round(agl)} м` });
  const az = Math.round(r.az) % 360;
  const t = r.target;
  return `<h2>До прицела · ${km(r.dist)}</h2>
    <p class="ps-verdict ${stCls(r.pair.status)}">${ICON[r.pair.status]} ${escapeHtml(pairVerdict(r.pair))}</p>
    <p>Нужная высота ${ALT_TEXT}: ${needLinesHtml(lineNeeds(r, r.rp, r.vp, mins))}</p>
    <img class="ps-profile" src="${img}" alt="Профиль трассы">
    <section class="ps-sec"><table class="ps-t">
      ${row('Прицел', `СК-42 ${sk42(t.lat, t.lon)} · WGS-84 ${wgs(t.lat, t.lon)} · рельеф ${Math.round(r.groundB)} м`)}
      ${row('Дальность, азимут', `${km(r.dist)} · ${az}° ${rumb(az)}`)}
      ${row('Дрон', `${S.droneH} м ${ALT_TEXT} · над землёй у прицела ${agl < 0 ? 'ниже склона' : `${Math.round(agl)} м`}`)}
      ${row('Запас', `управление ${margin(r.res)}${r.vres ? ` · видео ${margin(r.vres)}` : ''}`)}
    </table></section>`;
}

function gearBlock(): string {
  const ants = activeAntennaLines().map((l) => {
    const a = S.antenna[l];
    return `${LINE_TITLE[l]}: ${ANTENNA_TYPES[a.kind].name.toLowerCase()} ${a.gainDbi} дБи, луч ${a.beamDeg}°, азимут ${Math.round(a.heading)}° ${rumb(a.heading)}, наклон ${a.tiltDeg ?? 0}°`;
  });
  const st = S.station;
  return `<section class="ps-sec"><h2>Пульт и аппаратура</h2>
    <table class="ps-t">
      ${st ? row('Пульт', `СК-42 ${sk42(st.lat, st.lon)} · WGS-84 ${wgs(st.lat, st.lon)} · антенна ${st.antH} м над землёй${stationGround !== null ? ` · рельеф ${Math.round(stationGround)} м` : ''}`) : ''}
      ${row('Управление', escapeHtml(gear('rc')))}
      ${S.video.enabled ? row('Видео', escapeHtml(gear('video'))) : ''}
      ${row('Антенны на земле', ants.length ? ants.map(escapeHtml).join('<br>') : 'всенаправленные')}
    </table></section>`;
}

let printing = false;

/** Лист для печати (или «Сохранить как PDF» в диалоге печати): карта, профиль до прицела, таблицы. */
export async function printSheet(): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    const shot = await composeMap();
    const mapUrl = shot.canvas.toDataURL('image/jpeg', JPEG_Q);
    const gearHtml = gearBlock(); // аппаратура — на момент кадра, до ожидания профиля
    const target = shot.target; // прицел кадра, а не текущий
    let link = '';
    if (!S.station) { /* без пульта — только карта и аппаратура */ } else if (distance(S.station, target) <= 5) link = '<p>Прицел на пульте — сдвиньте карту на цель, и в лист попадут профиль и связь до неё.</p>';
    else if (stationGround === null) link = '<p>Профиль до прицела не построен: высота рельефа под пультом ещё не загружена или недоступна.</p>';
    else {
      try {
        const r = await calcLink(target);
        link = r ? linkBlock(r) : '<p>Профиль до прицела не построен: пульт перенесён во время подготовки листа — повторите.</p>';
      } catch (e) {
        if (!(e instanceof DemMissingError)) throw e;
        link = '<p>Профиль до прицела не построен: нет данных рельефа.</p>';
      }
    }
    const sheet = document.createElement('div');
    sheet.id = 'printSheet';
    sheet.innerHTML = `<h1>Радиус — связь с дроном <small>${human()}</small></h1>
      <img class="ps-map" src="${mapUrl}" alt="Карта">
      ${link}
      ${gearHtml}
      <p class="ps-note">Модель: свободное пространство + дифракция на рельефе (ITU-R P.526-15)${S.forest.on ? `; лес — по карте OpenStreetMap, деревья ${S.forest.height} м, затухание в кронах — ITU-R P.833` : ''}.
      Здания и помехи не учтены — это оценка, а не гарантия. ${escapeHtml(attribution())}</p>`;
    document.body.appendChild(sheet);
    document.documentElement.classList.add('printing');
    // Картинки (data URL) должны успеть разобраться до печати.
    await Promise.all([...sheet.querySelectorAll('img')].map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))));
    const done = () => { document.documentElement.classList.remove('printing'); sheet.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    // Где afterprint не приходит (печать не поддержана), лист убираем сами — он виден только при печати.
    setTimeout(() => { if (sheet.isConnected && !matchMedia('print').matches) done(); }, 60000);
  } catch {
    toast('Не удалось подготовить лист для печати', 4000);
  } finally {
    printing = false;
  }
}
