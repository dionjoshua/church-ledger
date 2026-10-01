const CACHE_NAME = 'church-ledger-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './mobile-style.css',
  './mobile-app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install Event — Pre-cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching static assets');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event — Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event — Network-First strategy for static assets, pass-through for APIs
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // If request is for an API endpoint, let the app handle it (always go to network)
  if (url.pathname.includes('/api/')) {
    return; // Pass through
  }

  // Network-First strategy for static assets
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If valid response, clone and update cache
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache if network is down/laptop offline
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // If not in cache and network fails, return a simple offline fallback if HTML requested
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('./index.html');
          }
        });
      })
  );
});
