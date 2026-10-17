// Линия пульт → прицел на карте и метки «здесь пропадёт связь» на ней: источники 'link' и 'link-loss',
// слои ov-link* / ov-loss*, «призрак» линии на время движения карты и кнопка у карты, включающая линию.
// Что рисовать (цвет, пунктир, метки) решает строка связи (live.ts); здесь — только карта.
import { S, $, map, center, setGeo, fc, line, persist } from './app';
import { LatLon } from './geo';
import { statusCss } from './verdict';

/** Цвет линии, пока для текущего прицела нет расчёта (движение карты, ожидание ответа). */
export const PENDING_COL = '#8b949e';

let linkDrawn = false; // в источнике 'link' есть линия
let lossDrawn = false;  // в источнике 'link-loss' есть метки
/** Линия пульт → прицел на карте включена (кнопка у карты; строка связи считает и без неё). */
export const linkOn = () => S.map.link;

/** Метки «здесь пропадёт связь» на линии (только у посчитанного результата — при любом другом виде линии убираются). */
export function setLoss(features: GeoJSON.Feature[]) {
  if (!linkOn()) features = [];
  if (!features.length && !lossDrawn) return;
  lossDrawn = features.length > 0;
  setGeo('link-loss', fc(features));
}

/** Линия связи в слое карты (GeoJSON → воркер MapLibre); null — убрать. Призрак движения при этом прячется. */
export function setLink(a: LatLon | null, c?: LatLon, props: Record<string, unknown> = {}) {
  ghost.hide();
  setLoss([]);
  if (!linkOn()) a = null; // выключена кнопкой у карты — источник пустой
  linkDrawn = !!(a && c);
  setGeo('link', a && c ? fc([line([[a.lon, a.lat], [c.lon, c.lat]], props)]) : fc());
}
export const linkLine = (a: LatLon, c: LatLon, props: Record<string, unknown>) => setLink(a, c, props);

/**
 * «Призрак» линии на время движения карты: SVG в экранных координатах поверх карты. setData на каждый кадр
 * заставлял воркер MapLibre заново нарезать источник и перерисовывать слой; отрезок между двумя точками
 * в проекции карты прямой — SVG рисует ту же линию без воркера. По окончании движения линия снова в слое.
 */
const ghost = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg: SVGSVGElement | null = null, casing: SVGLineElement, ln: SVGLineElement;
  const mk = () => {
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'link-ghost');
    svg.setAttribute('aria-hidden', 'true');
    casing = document.createElementNS(NS, 'line');
    ln = document.createElementNS(NS, 'line');
    casing.setAttribute('stroke-width', '7');
    ln.setAttribute('stroke-width', '4');
    ln.setAttribute('stroke', PENDING_COL);
    ln.setAttribute('stroke-opacity', '0.55');
    for (const l of [casing, ln]) { l.setAttribute('stroke-linecap', 'round'); svg.appendChild(l); }
    // Сразу за canvas: маркеры (пульт, метки) MapLibre добавляет в тот же контейнер позже — они остаются сверху.
    const cv = map.getCanvas();
    cv.parentNode!.insertBefore(svg, cv.nextSibling);
  };
  return {
    show(a: LatLon) {
      if (!svg) mk();
      // Обводка — как у слоя (её цвет и прозрачность зависят от темы, см. overlayPaint в app.ts).
      const col = map.getLayer('ov-link-casing') ? map.getPaintProperty('ov-link-casing', 'line-color') : '#000';
      const op = map.getLayer('ov-link-casing') ? map.getPaintProperty('ov-link-casing', 'line-opacity') : 0.45;
      casing.setAttribute('stroke', typeof col === 'string' ? col : '#000');
      casing.setAttribute('stroke-opacity', String(typeof op === 'number' ? op : 0.45));
      const p = map.project([a.lon, a.lat]);
      const c = center(); // та же цель, что у расчёта (с padding карты она не в середине контейнера)
      const q = map.project([c.lon, c.lat]);
      for (const l of [casing, ln]) {
        l.setAttribute('x1', p.x.toFixed(1)); l.setAttribute('y1', p.y.toFixed(1));
        l.setAttribute('x2', q.x.toFixed(1)); l.setAttribute('y2', q.y.toFixed(1));
      }
      svg!.style.display = '';
    },
    hide() { if (svg) svg.style.display = 'none'; },
  };
})();

/** Кадр движения карты: линия из слоя и метки убираются, вместо них — призрак от пульта a к кресту (если линия включена). */
export function linkGhost(a: LatLon) {
  if (linkDrawn) { linkDrawn = false; setGeo('link', fc()); }
  setLoss([]);
  if (linkOn()) ghost.show(a);
}
/** Спрятать призрак (линия в слое не меняется). */
export const hideGhost = () => ghost.hide();

/** Кнопка у карты — в состоянии S.map.link. */
export function syncLinkButton() {
  $('btnLink').classList.toggle('on', S.map.link);
  $('btnLink').setAttribute('aria-pressed', String(S.map.link));
}

let redraw: () => void = () => {};
/** Кто перерисует линию после включения кнопкой (строка связи знает цвет и метки последнего расчёта). */
export function onLinkToggle(fn: () => void) { redraw = fn; }

/** Кнопка у карты: показать/спрятать линию пульт → прицел (и метки потери связи на ней); выбор сохраняется. */
export function setLinkLine(on: boolean): void {
  S.map.link = on;
  persist();
  syncLinkButton();
  redraw();
  if (!on) setLink(null);
}

export function addLinkLayers() {
  map.addSource('link', { type: 'geojson', data: fc() });
  map.addLayer({ id: 'ov-link-casing', type: 'line', source: 'link', paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'ov-link', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 0], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['coalesce', ['get', 'op'], 1] } });
  map.addLayer({ id: 'ov-link-dash', type: 'line', source: 'link', filter: ['==', ['get', 'dash'], 1], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['coalesce', ['get', 'op'], 1], 'line-dasharray': [2, 2] } });
  // Где по пути пропадёт связь: точка на линии и подпись на тёмной обводке (читается и на снимке, и на топо).
  // Близкие события (склон и потеря связи рядом): точки — все, подпись при наложении — у ближнего к пульту.
  map.addSource('link-loss', { type: 'geojson', data: fc() });
  map.addLayer({ id: 'ov-loss', type: 'circle', source: 'link-loss', paint: { 'circle-radius': 6, 'circle-color': statusCss('none'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'ov-loss-label', type: 'symbol', source: 'link-loss',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-max-width': 30, 'symbol-sort-key': ['get', 'd'], 'text-ignore-placement': false },
    paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0, 0, 0, 0.85)', 'text-halo-width': 2 },
  });
}
