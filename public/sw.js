// Service worker de la versión web: hace la app instalable y utilizable sin
// conexión. Red primero (siempre la última versión) y caché como respaldo.

const CACHE = 'hw9zonas-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Solo archivos propios: los anuncios y demás peticiones externas no se tocan.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        const cached = (await cache.match(request)) || (request.mode === 'navigate' && (await cache.match('./')));
        return cached || Response.error();
      }
    })(),
  );
});
