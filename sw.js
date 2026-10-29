// Guarda la app para que abra rápido. Los datos siempre vienen de Supabase.
// Sube el número de versión cuando cambies archivos de la app.
const CACHE = 'tiempo-juego-v2';
const ARCHIVOS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Librería de Supabase (versión fija): primero la copia guardada.
  if (url.hostname === 'cdn.jsdelivr.net') {
    ev.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copia = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copia));
      return res;
    })));
    return;
  }

  // Archivos de la app: primero internet (para recibir cambios), si no hay, la copia.
  if (url.origin === location.origin) {
    ev.respondWith(fetch(req).then((res) => {
      const copia = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copia));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil(self.clients.matchAll({ type: 'window' }).then((ventanas) => {
    const abierta = ventanas.find((v) => 'focus' in v);
    return abierta ? abierta.focus() : self.clients.openWindow('./');
  }));
});
