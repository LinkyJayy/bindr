// Bindr service worker: offline app shell + offline copies of opened books.
const VERSION = 'v2';
const SHELL = `bindr-shell-${VERSION}`;
const BOOKS = 'bindr-books';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/pdf.js',
  '/js/reader.js',
  '/js/curl.js',
  '/manifest.webmanifest',
  '/icons/icon-32.png',
  '/icons/icon-64.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/glyph-256.png',
  '/vendor/pdfjs/pdf.min.mjs',
  '/vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('bindr-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Book files & covers: network first (so deletes/permissions are respected), cached copy offline.
  if (/^\/api\/books\/[^/]+\/(file|cover)$/.test(url.pathname)) {
    event.respondWith(networkThenCache(req, BOOKS, url.pathname.endsWith('/cover')));
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // other API calls always hit the network

  // App navigation: serve the shell (SPA), refresh it in the background.
  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(new Request('/index.html'), SHELL));
    return;
  }
  event.respondWith(staleWhileRevalidate(req, SHELL));
});

async function networkThenCache(req, cacheName, preferCache) {
  const cache = await caches.open(cacheName);
  const key = new URL(req.url).pathname; // ignore cache-busting query strings
  if (preferCache) {
    const hit = await cache.match(key);
    if (hit) {
      fetch(req).then((res) => res.ok && cache.put(key, res)).catch(() => {});
      return hit;
    }
  }
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) cache.put(key, res.clone());
    else if (res.status === 404 || res.status === 401) cache.delete(key);
    return res;
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await fresh) || new Response('Offline', { status: 503 });
}
