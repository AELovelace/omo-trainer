import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase, databasePath } from '../server/database.mjs';
import { startAnalysisWorker } from '../server/ai-analysis-supervisor.mjs';
import { createApi } from '../server/api.mjs';
import { createLogin } from '../server/login.mjs';
import { stickerCatalog } from '../server/sticker-catalog.mjs';
import { createGamesRoute } from '../server/games.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const base = process.env.BASE_PATH ?? '/tracker/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('BASE_PATH must start and end with / and contain only simple path segments.');
const database = openDatabase();
const stopAnalysisWorker=startAnalysisWorker(databasePath()); // One supervised background worker shares the private durable report queue.
const login = createLogin(database, base);
const api = createApi(database, login);
const games = createGamesRoute(base);
const stickerAssets = stickerCatalog();
const stickerPaths = new Map(stickerAssets.map(item => [item.url, item.path]));
const files = new Map([
  ['admin/ai-analysis.js','text/javascript; charset=utf-8'],
  ['admin/statistics.js','text/javascript; charset=utf-8'],
  ['lib/login-bonuses.js', 'text/javascript; charset=utf-8'], ['lib/login-bonuses.css', 'text/css; charset=utf-8'],
  ['lib/games.js', 'text/javascript; charset=utf-8'],
  ...stickerAssets.map(item => [item.url, item.mime]),
  ['coins/browser.js','text/javascript; charset=utf-8'],
  ['coins/index.html','text/html; charset=utf-8'], ['coins/app.js','text/javascript; charset=utf-8'], ['coins/style.css','text/css; charset=utf-8'],
  ['lib/prediction.js', 'text/javascript; charset=utf-8'], ['lib/prediction-view.js', 'text/javascript; charset=utf-8'],
  ['lib/reward-celebration.js', 'text/javascript; charset=utf-8'],
  ['lib/notifications.js', 'text/javascript; charset=utf-8'],
  ['lib/economy.js', 'text/javascript; charset=utf-8'],
  ['lib/reminder.js', 'text/javascript; charset=utf-8'],
  ['lib/theme.js', 'text/javascript; charset=utf-8'], ['theme-init.js', 'text/javascript; charset=utf-8'], ['themes.css', 'text/css; charset=utf-8'],
  ['index.html', 'text/html; charset=utf-8'], ['styles.css', 'text/css; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'], ['lib/model.js', 'text/javascript; charset=utf-8'], ['lib/sync.js', 'text/javascript; charset=utf-8'],
  ['lib/training.js', 'text/javascript; charset=utf-8'], ['lib/diapers.js', 'text/javascript; charset=utf-8'],
  ...['index.html', 'style.css', 'embedded.css', 'app.js', 'merge.js', 'account.js', 'crt-init.js', 'pwa.js', 'icons/icon-192.png', 'icons/icon-512.png'].map(name => [`potty_chart/${name}`, name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8']),
  ['admin/index.html', 'text/html; charset=utf-8'], ['admin/app.js', 'text/javascript; charset=utf-8'], ['admin/admin.css', 'text/css; charset=utf-8'],
  ['admin/notifications.js','text/javascript; charset=utf-8'],
  ['admin/chart-builder.js','text/javascript; charset=utf-8'], ['lib/chart-builder-model.js','text/javascript; charset=utf-8'],
  ['lib/admin-format.js', 'text/javascript; charset=utf-8'], ['lib/admin-analytics.js', 'text/javascript; charset=utf-8'],
  ['sw.js', 'text/javascript; charset=utf-8'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icons/notification-icon.png', 'image/png'], ['icons/notification-badge.png', 'image/png'],
  ['icons/icon.svg', 'image/svg+xml'], ['icons/icon-192.png', 'image/png'],
  ['icons/icon-512.png', 'image/png'], ['icons/maskable-512.png', 'image/png'], ['icons/apple-touch-icon.png', 'image/png'],
]);

export const server = http.createServer(async (request, response) => { // Serves only the public allowlist, never source tools, backups, or project documentation.
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (games(request, response, pathname)) return;
  if (pathname.startsWith(`${base}auth/`)) return login.route(request, response, pathname.slice(`${base}auth/`.length));
  if (pathname.startsWith(`${base}api/`)) return api(request, response, pathname.slice(`${base}api/`.length));
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); return response.end(); }
  if ((base !== '/' && pathname === base.slice(0, -1)) || (base !== '/' && pathname === '/')) {
    response.writeHead(308, { Location: base });
    return response.end();
  }
  if (!pathname.startsWith(base)) { response.writeHead(404); return response.end('Not found'); }
  if (pathname === `${base}coins`) {response.writeHead(308,{Location:`${base}coins/`});return response.end();}
  if (pathname === `${base}admin`) { response.writeHead(308, { Location: `${base}admin/` }); return response.end(); }
  if ([`${base}potty_chart`, `${base}potty_chart/`, `${base}potty_chart/index.html`].includes(pathname)) { response.writeHead(308, { Location: `${base}#potty-chart` }); return response.end(); } // Old chart bookmarks now open the integrated view.
  const filename = pathname.slice(base.length) === 'coins/' ? 'coins/index.html' : pathname.slice(base.length) === 'admin/' ? 'admin/index.html' : pathname.slice(base.length) === 'potty_chart/' ? 'potty_chart/index.html' : pathname.slice(base.length) || 'index.html';
  if (!files.has(filename)) { response.writeHead(404); return response.end('Not found'); }
  try {
    const assetPath = stickerPaths.get(filename) ?? filename;
    const content = await readFile(path.join(root, assetPath));
    response.writeHead(200, { 'Content-Type': files.get(filename), 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(503); response.end('App asset unavailable'); }
});

const rewardTimer=setInterval(()=>database.economy.tryFlush(),30000);rewardTimer.unref(); // Resume reward delivery even without another record submission.
server.on('close', () => {stopAnalysisWorker();clearInterval(rewardTimer);database.close();}); // Flushes and closes the persistent connection during controlled shutdowns and tests.
server.requestTimeout = 15000;
server.headersTimeout = 10000;

server.listen(port, host, () => { // Binds locally by default; set HOST to a private interface when the reverse proxy runs on another server.
  console.log(`Little Log is running at http://${host}:${server.address().port}${base}`);
});

const notificationTimer=setInterval(()=>{void database.notifications.tick().catch(()=>{});},60000); // Deliver even while the PWA is closed.
notificationTimer.unref();
server.on('close',()=>clearInterval(notificationTimer));
