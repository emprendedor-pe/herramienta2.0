// Service worker "red primero": siempre intenta bajar la versión nueva del sitio.
// Solo usa la copia guardada si no hay internet. Así no vuelve a quedarse pegado en una versión vieja.
const CACHE = 'lunara-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // Apps Script y APIs pasan directo
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
