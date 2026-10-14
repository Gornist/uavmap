// Service Worker (injectManifest). Без библиотек: чистый Cache API.
// Кеши: uavmap-shell-<hash> (оболочка), uavmap-dem-v1 (районы, пишет offline.ts — не вытесняется),
// uavmap-dem-runtime (просмотренные тайлы рельефа, лимит). Глифы карты (public/fonts) — в оболочке.
// Подложки Esri/OSM/OpenTopoMap намеренно НЕ кешируются (условия провайдеров).

import { DEM_PREFIX } from './demTiles';

const sw = self as unknown as ServiceWorkerGlobalScope;

interface ManifestEntry { url: string; revision: string | null }

const DEM_AREA = 'uavmap-dem-v1';
// v2: в прежнем кеше могли остаться недописанные ответы (сеть встала посреди тайла) — их чтение висело вечно.
const DEM_RUNTIME = 'uavmap-dem-runtime-v2';
const OLD_CACHES = ['uavmap-dem-runtime', 'uavmap-glyphs'];
/** Запрос в сеть из Service Worker: сеть пульта иногда «встаёт» посреди ответа — без таймаута он висел бы вечно. */
const NET_TIMEOUT_MS = 15000;
const DEM_RUNTIME_MAX = 3000;
const SHELL_PREFIX = 'uavmap-shell-';

const entries = (self as unknown as { __WB_MANIFEST: Array<ManifestEntry | string> }).__WB_MANIFEST.map((e) => (typeof e === 'string' ? { url: e, revision: null } : e));
const shellUrls = entries.map((e) => new URL(e.url, sw.registration.scope).href);

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const SHELL = SHELL_PREFIX + hash(entries.map((e) => e.url + (e.revision ?? '')).join('|'));

sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // cache: 'reload' — не брать устаревшие копии из HTTP-кеша
    await Promise.all(shellUrls.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error(`precache ${u}: ${res.status}`);
      await cache.put(u, res);
    }));
  })());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith(SHELL_PREFIX) && k !== SHELL) || OLD_CACHES.includes(k)) await caches.delete(k);
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

async function trim(cacheName: string, max: number): Promise<void> {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/**
 * Ответ из сети целиком (тело прочитано) под одним таймаутом. В кеш попадает только полный ответ:
 * недописанная запись читалась бы вечно — так у пользователя навсегда «пропадали» тайлы рельефа.
 */
async function fetchFull(req: Request): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(req, { signal: ac.signal });
    if (!res.ok || res.type === 'opaque') return res;
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(req: Request, cacheName: string, limit = 0): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetchFull(req);
  if (res.ok) {
    await cache.put(req.url, res.clone());
    if (limit) void trim(cacheName, limit);
  }
  return res;
}

async function demTile(req: Request): Promise<Response> {
  // «Обновить район» запрашивает с cache: 'reload' — идём в сеть мимо обоих кешей (район перезапишет страница).
  if (req.cache === 'reload') return fetchFull(req);
  const area = await caches.open(DEM_AREA);
  const hit = await area.match(req.url);
  if (hit) return hit;
  return cacheFirst(req, DEM_RUNTIME, DEM_RUNTIME_MAX);
}

async function shell(req: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  if (req.mode === 'navigate') {
    const index = await cache.match(new URL('index.html', sw.registration.scope).href);
    try {
      return await fetch(req);
    } catch {
      if (index) return index;
      throw new Error('offline and no shell');
    }
  }
  const hit = await cache.match(req.url, { ignoreSearch: true });
  return hit ?? fetch(req);
}

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (url.startsWith(DEM_PREFIX)) event.respondWith(demTile(req));
  else if (req.mode === 'navigate' && url.startsWith(sw.registration.scope)) event.respondWith(shell(req));
  else if (shellUrls.includes(url.split('?')[0].split('#')[0])) event.respondWith(shell(req));
});

export {};
