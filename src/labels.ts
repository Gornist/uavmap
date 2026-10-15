// Подписи и дороги поверх подложки — векторные тайлы OpenFreeMap (схема OpenMapTiles, данные OpenStreetMap):
// один источник с тайлами 512 px по HTTP/2 вместо двух растровых слоёв Esri (256 px, HTTP/1.1); текст чёткий,
// есть вершины с высотами и грунтовки. Запасной путь — растровые подписи Esri (слои roads/places в app.ts): если
// векторные тайлы не приходят (на пульте однажды висели до таймаута, причина не найдена), карта переходит на них.
import type { LayerSpecification, SourceSpecification, ExpressionSpecification } from 'maplibre-gl';
import { VEC_PROTO } from './netTiles';

export const LABELS_TILEJSON = `${VEC_PROTO}://tiles.openfreemap.org/planet`;
const ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© участники OpenStreetMap</a>';

export const labelsSource = (): SourceSpecification => ({ type: 'vector', url: LABELS_TILEJSON, attribution: ATTR });

// ---------- Переход на запасные подписи ----------
const FALLBACK_KEY = 'uavmap.labels.fallback';
/** Сколько после перехода стартовать сразу с растровыми подписями (не ждать таймаутов векторных). */
export const FALLBACK_MS = 6 * 3600 * 1000;
/** Подряд не пришедших тайлов — и переход (не пришёл TileJSON — сразу). */
export const FAIL_LIMIT = 2;

/** Векторные подписи можно пробовать: переход был давно (или не был). */
export function vectorAllowed(now = Date.now()): boolean {
  try {
    const t = Number(localStorage.getItem(FALLBACK_KEY));
    return !(t > 0 && now - t < FALLBACK_MS && t <= now);
  } catch { return true; }
}

/** Счётчик исходов загрузки: FAIL_LIMIT сбоев подряд или fatal → onFallback (один раз, с отметкой в localStorage). */
export function labelHealth(onFallback: () => void, now = () => Date.now()) {
  let fails = 0, done = false;
  return (ok: boolean, fatal = false) => {
    if (done) return;
    if (ok) { fails = 0; return; }
    if (++fails < FAIL_LIMIT && !fatal) return;
    done = true;
    try { localStorage.setItem(FALLBACK_KEY, String(now())); } catch { /* нет места — в следующий раз попробуем снова */ }
    onFallback();
  };
}

const FONT = ['Noto Sans Regular']; // свои глифы (public/fonts): латиница и кириллица
// Русское название, иначе латинская транслитерация (её OpenMapTiles даёт всем объектам): других письменностей
// в наших глифах нет — вместо них был бы пропуск символов.
const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:ru'], ['get', 'name:latin']];
const z = (...stops: number[]): ExpressionSpecification => ['interpolate', ['exponential', 1.4], ['zoom'], ...stops] as ExpressionSpecification;
const cls = (...c: string[]): ExpressionSpecification => ['match', ['get', 'class'], c, true, false];
// Вершины: безымянные — только с z13 (иначе одинокие «1856 м» путаются с подписями горизонталей).
const PEAK: ExpressionSpecification = ['all', cls('peak', 'volcano'), ['any', ['>=', ['zoom'], 13], ['to-boolean', NAME]]];

/** Цвета под подложку: на спутнике — светлые с тёмным ореолом, на светлых топо/схеме — наоборот. */
function ink(sat: boolean) {
  return sat
    ? { text: '#ffffff', halo: 'rgba(0, 0, 0, 0.75)', major: '#ffd27a', road: '#ffffff', track: '#f3e2bf', water: '#a8dcff', peak: '#ffe9c4', border: '#ffffff', casing: 'rgba(0, 0, 0, 0.45)' }
    : { text: '#2b241c', halo: 'rgba(255, 255, 255, 0.85)', major: '#c77d1e', road: '#6b6156', track: '#8a6a3a', water: '#2a6fa8', peak: '#5a3d1e', border: '#6a4f7a', casing: 'rgba(255, 255, 255, 0.6)' };
}

/** Краска слоёв подписей под подложку (для setPaintProperty при смене подложки). */
export function labelPaint(sat: boolean): Record<string, Record<string, unknown>> {
  const k = ink(sat);
  const txt = { 'text-color': k.text, 'text-halo-color': k.halo };
  return {
    'lbl-boundary': { 'line-color': k.border }, 'lbl-rail': { 'line-color': k.road }, 'lbl-track': { 'line-color': k.track },
    'lbl-road-minor': { 'line-color': k.road }, 'lbl-road-mid': { 'line-color': k.road },
    'lbl-road-major-casing': { 'line-color': k.casing }, 'lbl-road-major': { 'line-color': k.major },
    'lbl-waterway-name': { 'text-color': k.water, 'text-halo-color': k.halo }, 'lbl-road-name': txt, 'lbl-road-ref': txt,
    'lbl-peak-dot': { 'circle-color': k.peak, 'circle-stroke-color': k.halo }, 'lbl-peak': { 'text-color': k.peak, 'text-halo-color': k.halo },
    'lbl-place-small': txt, 'lbl-place-town': txt, 'lbl-place-city': txt, 'lbl-place-region': txt,
  };
}

/** Слои векторных подписей (id lbl-*; видимость и краску под подложку переключает applyMapStyle). */
export function labelLayers(sat: boolean, visible: boolean): LayerSpecification[] {
  const p = labelPaint(sat);
  const layout = { visibility: visible ? 'visible' : 'none' } as const;
  const src = { source: 'labels' };
  const text = (size: ExpressionSpecification | number, extra: Record<string, unknown> = {}) => ({ ...layout, 'text-font': FONT, 'text-size': size, 'text-field': NAME, 'text-max-width': 8, ...extra });
  const halo = { 'text-halo-width': 1.4, 'text-halo-blur': 0.3 };
  const round = { ...layout, 'line-cap': 'round', 'line-join': 'round' };
  return [
    { id: 'lbl-boundary', type: 'line', ...src, 'source-layer': 'boundary', minzoom: 3, filter: ['all', ['in', ['get', 'admin_level'], ['literal', [2, 4]]], ['!=', ['get', 'maritime'], 1]], layout, paint: { ...p['lbl-boundary'], 'line-opacity': 0.6, 'line-width': z(3, 0.6, 10, 1.6), 'line-dasharray': [3, 2] } },
    { id: 'lbl-rail', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 10, filter: cls('rail'), layout, paint: { ...p['lbl-rail'], 'line-opacity': 0.6, 'line-width': 1, 'line-dasharray': [3, 3] } },
    { id: 'lbl-track', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 12, filter: cls('track', 'path'), layout, paint: { ...p['lbl-track'], 'line-opacity': 0.75, 'line-width': z(12, 0.7, 16, 1.6), 'line-dasharray': [2, 1.5] } },
    { id: 'lbl-road-minor', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 12, filter: cls('minor', 'service'), layout: round, paint: { ...p['lbl-road-minor'], 'line-opacity': 0.55, 'line-width': z(12, 0.5, 16, 3) } },
    { id: 'lbl-road-mid', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 8, filter: cls('secondary', 'tertiary'), layout: round, paint: { ...p['lbl-road-mid'], 'line-opacity': 0.75, 'line-width': z(8, 0.5, 14, 2.4, 17, 6) } },
    { id: 'lbl-road-major-casing', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 5, filter: cls('motorway', 'trunk', 'primary'), layout: round, paint: { ...p['lbl-road-major-casing'], 'line-width': z(5, 1.4, 14, 5, 17, 11) } },
    { id: 'lbl-road-major', type: 'line', ...src, 'source-layer': 'transportation', minzoom: 5, filter: cls('motorway', 'trunk', 'primary'), layout: round, paint: { ...p['lbl-road-major'], 'line-opacity': 0.9, 'line-width': z(5, 0.6, 14, 3, 17, 8) } },
    { id: 'lbl-waterway-name', type: 'symbol', ...src, 'source-layer': 'waterway', minzoom: 12, filter: ['has', 'name'], layout: text(11, { 'symbol-placement': 'line', 'symbol-spacing': 400 }), paint: { ...p['lbl-waterway-name'], ...halo } },
    { id: 'lbl-road-name', type: 'symbol', ...src, 'source-layer': 'transportation_name', minzoom: 13, layout: text(11, { 'symbol-placement': 'line', 'symbol-spacing': 350 }), paint: { ...p['lbl-road-name'], ...halo } },
    { id: 'lbl-road-ref', type: 'symbol', ...src, 'source-layer': 'transportation_name', minzoom: 8, maxzoom: 13, filter: ['all', ['has', 'ref'], cls('motorway', 'trunk', 'primary')], layout: text(10, { 'text-field': ['get', 'ref'], 'symbol-placement': 'line', 'symbol-spacing': 500 }), paint: { ...p['lbl-road-ref'], ...halo } },
    { id: 'lbl-peak-dot', type: 'circle', ...src, 'source-layer': 'mountain_peak', minzoom: 11, filter: PEAK, layout, paint: { ...p['lbl-peak-dot'], 'circle-radius': 2.5, 'circle-stroke-width': 1 } },
    { id: 'lbl-peak', type: 'symbol', ...src, 'source-layer': 'mountain_peak', minzoom: 11, filter: PEAK, layout: text(11, { 'text-field': ['case', ['has', 'ele'], ['case', ['to-boolean', NAME], ['concat', NAME, '\n', ['to-string', ['round', ['get', 'ele']]], ' м'], ['concat', ['to-string', ['round', ['get', 'ele']]], ' м']], NAME], 'text-anchor': 'top', 'text-offset': [0, 0.3] }), paint: { ...p['lbl-peak'], ...halo } },
    { id: 'lbl-place-small', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 11, filter: cls('village', 'hamlet', 'suburb', 'neighbourhood', 'isolated_dwelling', 'locality'), layout: text(z(11, 10.5, 15, 13)), paint: { ...p['lbl-place-small'], ...halo } },
    { id: 'lbl-place-town', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 8, filter: cls('town'), layout: text(z(8, 11, 14, 15)), paint: { ...p['lbl-place-town'], ...halo } },
    { id: 'lbl-place-city', type: 'symbol', ...src, 'source-layer': 'place', minzoom: 4, filter: cls('city'), layout: text(z(4, 11, 12, 16)), paint: { ...p['lbl-place-city'], ...halo } },
    { id: 'lbl-place-region', type: 'symbol', ...src, 'source-layer': 'place', maxzoom: 9, filter: cls('country', 'state'), layout: text(z(2, 10, 8, 13), { 'text-letter-spacing': 0.08 }), paint: { ...p['lbl-place-region'], ...halo, 'text-opacity': 0.85 } },
  ] as LayerSpecification[];
}
