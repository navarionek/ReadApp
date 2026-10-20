// Podbij wersję przy zmianie listy ASSETS; zwykłe deploye i tak łapie network-first
const CACHE_NAME = 'czytanko-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png'
];

// Install Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker: usuń stare cache (m.in. cache-first z v1)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(cache => cache !== CACHE_NAME)
          .map(cache => caches.delete(cache))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetching strategy: Network-First, cache tylko jako fallback offline
self.addEventListener('fetch', event => {
  const req = event.request;
  // Supabase, CDN itp. idą normalnie przez sieć
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Nawigacje (też powrót z OAuth z ?code=...) trzymamy pod jednym kluczem
  const cacheKey = req.mode === 'navigate' ? './' : req;

  // no-cache: zawsze pytaj serwer (304 jeśli bez zmian), omijając max-age=600 z GitHub Pages.
  // Requestu z mode 'navigate' nie da się sklonować z opcjami, więc budujemy go z URL.
  const netReq = req.mode === 'navigate'
    ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(req, { cache: 'no-cache' });

  event.respondWith(
    fetch(netReq)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
