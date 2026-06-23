/* ════════════════════════════════════════
   sw.js — Service Worker (PWA offline support)
   ════════════════════════════════════════ */

const CACHE  = "school-nfc-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.json"
];

// Install: pre-cache shell
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for Firebase, cache-first for assets
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Always go network for Firebase APIs
  if (url.hostname.includes("firebase") ||
      url.hostname.includes("googleapis") ||
      url.hostname.includes("gstatic")) {
    return; // browser handles it
  }

  // Cache-first for local assets
  event.respondWith(
    caches.match(event.request).then(cached => cached ||
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(c => c.put(event.request, clone));
        return response;
      })
    )
  );
});
