const CACHE = `little-log-v46-pastel-charts-${self.registration.scope}`; // Keeps caches separate when multiple app paths share an origin.
const SHELL = ['./', './index.html', './styles.css', './themes.css', './theme-init.js', './lib/theme.js', './lib/reminder.js', './app.js', './lib/model.js', './lib/prediction.js', './lib/prediction-view.js', './lib/sync.js', './lib/training.js', './lib/diapers.js', './lib/economy.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
SHELL.push(...['embedded.css', 'app.js', 'merge.js', 'account.js'].map(name => `./potty_chart/${name}`)); // Keep the complete chart available inside the installed PWA.
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
  if (url.search) return;
  if (event.request.mode === 'navigate' && ['potty_chart','potty_chart/','potty_chart/index.html'].some(path => url.href === new URL(path, self.registration.scope).href)) {
    event.respondWith(Promise.resolve(Response.redirect(new URL('./#potty-chart', self.registration.scope).href, 302))); return; // Resolve old installed shortcuts even while offline.
  } // Authentication parameters must never be rewritten into a public cached page.
  url.hash = ''; // Navigation requests may include the app's hash route; all routes use the same cached shell.
  if (!ASSETS.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) ?? fetch(event.request)));
});
