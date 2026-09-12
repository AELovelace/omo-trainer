const CACHE = `little-log-v10-observation-column-${self.registration.scope}`; // Keeps caches separate when multiple app paths share an origin.
const SHELL = ['./', './index.html', './styles.css', './app.js', './lib/model.js', './lib/sync.js', './lib/training.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
const ASSETS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => { // Installs an entire app version before it can become active.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => { // Removes only old Little Log caches for this exact scope.
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('little-log-') && key.endsWith(`-${self.registration.scope}`) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => { // Serves the versioned public app shell offline; never caches personal records or neighboring site routes.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  url.hash = ''; // Navigation requests may include the app's hash route; all routes use the same cached shell.
  if (!ASSETS.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) ?? fetch(event.request)));
});
