/* Service worker — coquille hors-ligne + accélération du chargement.
   Règle d'or : on ne met JAMAIS en cache les réponses /api (authentifiées,
   changeantes) ni les requêtes non-GET. Le réseau reste la source de vérité. */
const VERSION = 'ics-v83';
const CORE = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/reglement.js',
  '/js/geoloc.js',
  '/js/anim.js',
  '/vendor/gsap/gsap.min.js',
  '/js/lottie-anim.js',
  '/vendor/lottie/lottie_light.min.js',
  '/anim/loader.json',
  '/anim/success.json',
  '/anim/validate.json',
  '/anim/error.json',
  '/anim/pending.json',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/img/logo.png',
  '/img/logo.svg',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/img/van-schema.jpg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// --- Notifications push (Web Push) ---------------------------------------
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text ? event.data.text() : '' }; }
  const title = d.title || 'Inter Colis Services';
  const options = {
    body: d.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' },
    lang: 'fr',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // jamais de cache pour POST/PUT/DELETE
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // tiers (CDN OCR…) -> réseau direct
  if (url.pathname.startsWith('/api/')) return;          // API -> réseau (auth/fraîcheur)
  if (url.pathname.startsWith('/calendar/')) return;     // flux iCal -> réseau

  // Réseau d'abord (toujours frais quand on est en ligne, jamais de version
  // figée après un déploiement) ; le cache ne sert que de repli hors-ligne.
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error())))
  );
});
