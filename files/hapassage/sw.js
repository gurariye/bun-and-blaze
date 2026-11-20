/* Hapassage service worker: the app shell works offline, content refreshes in the background. */
const VERSION = 'hp-v1';
const SHELL = CACHE_SHELL();
const RUNTIME = VERSION + '-rt';
const MAX_RUNTIME = 80;

function CACHE_SHELL() {
  return ['./', 'home.html', 'premium.html', 'manifest-home.webmanifest', 'manifest-premium.webmanifest',
    'icons/home-any-192.png', 'icons/home-any-512.png', 'icons/home-apple-180.png',
    'icons/premium-any-192.png', 'icons/premium-any-512.png', 'icons/premium-apple-180.png'];
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cacheName) {
  const c = await caches.open(cacheName), keys = await c.keys();
  if (keys.length > MAX_RUNTIME) await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME).map(k => c.delete(k)));
}

/* pages: network first (so edits arrive), cached copy when offline */
async function page(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch (err) {
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('home.html')) || Response.error();
  }
}

/* images, fonts, icons: instant from cache, refreshed behind the scenes */
async function swr(req) {
  const c = await caches.open(RUNTIME), hit = await c.match(req);
  const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) { c.put(req, res.clone()); trim(RUNTIME); } return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') { e.respondWith(page(req)); return; }
  const same = url.origin === self.location.origin;
  const media = /\.(png|jpe?g|webp|svg|woff2?|ico)$/i.test(url.pathname);
  if (same || media || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname.endsWith('hapassage.com')) {
    e.respondWith(swr(req));
  }
});

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
