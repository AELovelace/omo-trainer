const CACHE = `little-log-v68-menu-order-${self.registration.scope}`; // Refresh the shared desktop and mobile menu order for installed apps.
const SHELL = ['./lib/login-bonuses.js', './lib/login-bonuses.css', './lib/games.js', './lib/notifications.js', './lib/reward-celebration.js', './', './index.html', './styles.css', './themes.css', './theme-init.js', './lib/theme.js', './lib/reminder.js', './app.js', './lib/model.js', './lib/prediction.js', './lib/prediction-view.js', './lib/sync.js', './lib/training.js', './lib/diapers.js', './lib/economy.js', './manifest.webmanifest', './icons/notification-icon.png', './icons/notification-badge.png', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
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

self.addEventListener('push',event=>{ // Server payloads carry no records, account names or model details.
 let data;try{data=event.data?.json();}catch{return;}
 const adminMessage=data?.kind==='admin-message';
 if(adminMessage&&(typeof data.title!=='string'||!data.title.trim()||data.title.length>80||typeof data.body!=='string'||!data.body.trim()||data.body.length>500))return;
 if(!adminMessage&&data?.title!=='Potty check-in')return;
 event.waitUntil(self.registration.showNotification(adminMessage?data.title:'Potty check-in',{body:adminMessage?data.body:'Pee NOW! Time for a potty check-in.',icon:new URL('./icons/notification-icon.png',self.registration.scope).href,badge:new URL('./icons/notification-badge.png',self.registration.scope).href,tag:typeof data.tag==='string'?data.tag.slice(0,80):'potty-reminder'}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const target=new URL('./#overview',self.registration.scope).href;
 event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});const existing=windows.find(client=>client.url.startsWith(self.registration.scope));if(existing){await existing.navigate(target);await existing.focus();}else await self.clients.openWindow(target);})());
});
