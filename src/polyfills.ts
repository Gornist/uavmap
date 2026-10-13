// Минимальные полифиллы для старых Chrome/WebView (пульты-планшеты без Google Play, Chrome 68+).
// Синтаксис транспилирует сборка (target chrome68), а этих API в Chrome 68 нет.
/* eslint-disable @typescript-eslint/no-explicit-any */
import './polyfillsBase'; // первым — до MapLibre (globalThis, fromEntries и т. д.)
import maplibregl from 'maplibre-gl';
// Воркер MapLibre той же версии (CSP-сборка) как отдельный файл — для обёртки на старых браузерах.
import cspWorkerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url';
// postMessage(msg, { transfer }) — с Chrome 77. MapLibre 4 шлёт так и со страницы, и из своего воркера.
// На старых браузерах: на странице оборачиваем Worker.prototype.postMessage, а воркер MapLibre
// запускаем из CSP-сборки через обёртку, которая делает ту же подмену внутри воркера.
function optionsFormSupported(): boolean {
  try { new MessageChannel().port1.postMessage(0, { transfer: [] } as any); return true; } catch { return false; }
}
if (typeof Worker !== 'undefined' && !optionsFormSupported()) {
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, msg: unknown, opt?: any) {
    if (opt && !Array.isArray(opt) && typeof opt === 'object') return orig.call(this, msg, opt.transfer || []);
    return opt === undefined ? orig.call(this, msg) : orig.call(this, msg, opt);
  } as typeof Worker.prototype.postMessage;
  const abs = new URL(cspWorkerUrl, location.href).href;
  // + Array.prototype.flat (Chrome 69): встречается в коде воркера MapLibre.
  const flat = `if(!Array.prototype.flat){Array.prototype.flat=function(d){d=d===undefined?1:d;return d<1?this.slice():this.reduce(function(a,v){return a.concat(Array.isArray(v)?v.flat(d-1):v)},[])};Array.prototype.flatMap=function(f,t){return this.map(f,t).flat(1)};}`;
  const src = flat + `(function(){var p=self.postMessage.bind(self);self.postMessage=function(m,o){if(o&&!Array.isArray(o)&&typeof o==='object')return p(m,o.transfer||[]);return o===undefined?p(m):p(m,o)};})();importScripts(${JSON.stringify(abs)});`;
  maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

export {};
