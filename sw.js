/**
 * ScanSheet Service Worker
 * Provides offline shell fallback in project theme, resilient caching, and network recovery.
 */

const CACHE_NAME = 'scansheet-v1.0.0';
const OFFLINE_URL = '/offline.html';

// Core assets to pre-cache on installation
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/offline',
  '/manifest.json',
  '/css/style.css?v=6.6',
  '/css/style.css',
  '/css/responsive.css?v=6.6',
  '/css/responsive.css',
  '/assets/icons/logo.svg',
  '/assets/icons/sheet.svg',
  '/assets/icons/info.svg',
  '/assets/icons/close.svg',
  '/assets/icons/menu.svg',
  '/assets/icons/user.svg',
  '/assets/icons/upload.svg',
  '/assets/icons/crop.svg',
  '/assets/icons/rotate.svg',
  '/assets/icons/trash.svg',
  '/assets/icons/eye.svg',
  '/assets/icons/eye-off.svg',
  '/assets/icons/google.svg',
  '/js/app.js?v=6.8',
  '/js/app.js',
  '/js/ui.js',
  '/js/utils.js',
  '/js/auth.js',
  '/js/upload.js',
  '/js/editor.js',
  '/js/export.js',
  '/js/history.js',
  '/js/supabase-client.js',
  '/js/vendor/supabase.min.js',
  '/js/vendor/jszip.min.js',
  '/js/vendor/xlsx.full.min.js',
  '/js/vendor/docx.umd.js',
  '/js/vendor/jspdf.umd.min.js',
  '/js/vendor/jspdf.plugin.autotable.min.js'
];

// Install Event: Pre-cache static shell & offline fallback
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Use allSettled to ensure resilient caching even if individual assets fail
      await Promise.allSettled(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn('[ScanSheet SW] Precache missed for:', url, err);
          }
        })
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: Clear older caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Broadcast offline signal to all connected window tabs
function broadcastOffline() {
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage({ type: 'NETWORK_OFFLINE' });
    });
  }).catch(() => {});
}

// Fetch Event: Intelligent routing
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignore non-GET requests (e.g., POST/PUT/DELETE cannot be cached)
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Ignore browser extension and non-http(s) schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // Fast-track: Direct cache return for the offline page itself
  if (url.pathname === '/offline' || url.pathname === '/offline.html') {
    event.respondWith(
      caches.match(OFFLINE_URL).then((cached) => cached || fetch(request))
    );
    return;
  }

  // 1. NAVIGATION REQUESTS (User entering website or refreshing)
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Network-first for navigation to get fresh content
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (error) {
          broadcastOffline();
          // Network failed (device is offline) -> Serve themed offline page
          const cache = await caches.open(CACHE_NAME);
          const cachedOffline = await cache.match(OFFLINE_URL);
          if (cachedOffline) {
            return cachedOffline;
          }

          // Fallback to cached index or root if offline.html is missing
          const cachedIndex = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cachedIndex) {
            return cachedIndex;
          }

          // Ultimate fallback
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Offline - ScanSheet</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>ScanSheet Offline</h2><p>Please check your internet connection and reload.</p></body></html>',
            {
              status: 503,
              statusText: 'Offline',
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        }
      })()
    );
    return;
  }

  // 2. API ENDPOINTS: Network-only with JSON offline fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        broadcastOffline();
        return new Response(
          JSON.stringify({
            error: 'You are currently offline. Please reconnect to the internet.',
            offline: true
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // 3. STATIC ASSETS (CSS, JS, Fonts, Icons, SVGs): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached immediately, then revalidate in background
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
            }
          })
          .catch(() => {
            // Network silent failure is expected while offline
          });
        return cachedResponse;
      }

      // Not in cache -> fetch from network
      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline and asset is an image, can return an empty or SVG placeholder
          if (request.destination === 'image') {
            return new Response('', { status: 408, statusText: 'Offline' });
          }
          return new Response('', { status: 408, statusText: 'Offline' });
        });
    })
  );
});

// Support manual skip-waiting trigger if requested
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

