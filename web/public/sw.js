/* Service worker: lets the app open and show the last-seen data without a connection.
 *
 *  - Navigations: network first, falling back to the cached app shell.
 *  - /assets/* (content-hashed): cache first.
 *  - GET /api/*: network first, falling back to the last good response. Only network failures fall back;
 *    a real 4xx/5xx from the server is passed through so errors are never masked by stale data.
 *  - Everything else (icons, manifest): serve cached, refresh in the background.
 *
 * Writes made offline are queued by the page itself (see src/lib/offline.ts), not here.
 */
const VERSION = "v1";
const SHELL = `tm-shell-${VERSION}`;
const API = `tm-api-${VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icons/icon.svg"];

// Responses that must never be served from a cache.
const NO_CACHE_API = [/^\/api\/export/, /^\/api\/integrations\/google\/(connect|callback)/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, API].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const networkFirst = async (request, cacheName, fallbackKey) => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(fallbackKey ?? request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(fallbackKey ?? request);
    if (hit) return hit;
    throw err;
  }
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Every route serves the same shell; cache it under "/" so any deep link works offline.
    event.respondWith(networkFirst(request, SHELL, "/"));
  } else if (url.pathname.startsWith("/api/")) {
    if (NO_CACHE_API.some((re) => re.test(url.pathname))) return;
    event.respondWith(networkFirst(request, API));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  } else {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request);
        const refresh = fetch(request)
          .then((r) => (r.ok && cache.put(request, r.clone()), r))
          .catch(() => hit);
        return hit ?? refresh;
      }),
    );
  }
});
