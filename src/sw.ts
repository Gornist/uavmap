// Service Worker (injectManifest). Без зависимостей: чистый Cache API.
// Кеши: uavmap-shell-<hash> (оболочка), uavmap-dem-v1 (районы, пишет offline.ts — не вытесняется),
// uavmap-dem-runtime (просмотренные тайлы рельефа, лимит), uavmap-glyphs (шрифты карты).
// Подложки Esri/OSM/OpenTopoMap намеренно НЕ кешируются (условия провайдеров).

const sw = self as unknown as ServiceWorkerGlobalScope;

interface ManifestEntry { url: string; revision: string | null }

const DEM_PREFIX = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
const GLYPH_PREFIX = 'https://demotiles.maplibre.org/font/';
const DEM_AREA = 'uavmap-dem-v1';
const DEM_RUNTIME = 'uavmap-dem-runtime';
const GLYPHS = 'uavmap-glyphs';
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
    for (const k of await caches.keys()) if (k.startsWith(SHELL_PREFIX) && k !== SHELL) await caches.delete(k);
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

async function cacheFirst(req: Request, cacheName: string, limit = 0): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req.url, res.clone());
    if (limit) void trim(cacheName, limit);
  }
  return res;
}

async function demTile(req: Request): Promise<Response> {
  // «Обновить район» запрашивает с cache: 'reload' — идём в сеть мимо обоих кешей (район перезапишет страница).
  if (req.cache === 'reload') return fetch(req);
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
  else if (url.startsWith(GLYPH_PREFIX)) event.respondWith(cacheFirst(req, GLYPHS));
  else if (req.mode === 'navigate' && url.startsWith(sw.registration.scope)) event.respondWith(shell(req));
  else if (shellUrls.includes(url.split('?')[0].split('#')[0])) event.respondWith(shell(req));
});

export {};
