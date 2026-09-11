import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Provider from 'oidc-provider';
import { openAuthStore } from '../auth/store.mjs';
import { loadAuthConfig } from '../auth/config.mjs';

const config = loadAuthConfig();
const store = openAuthStore();
const secure = config.issuer.startsWith('https:');
export const provider = new Provider(config.issuer, {
  clients: config.clients, adapter: store.Adapter, jwks: config.jwks,
  cookies: { keys: config.cookieKeys, long: { secure, sameSite: 'lax' }, short: { secure, sameSite: 'lax' } },
  features: { devInteractions: { enabled: false } },
  pkce: { required: () => true },
  claims: { openid: ['sub'], profile: ['preferred_username'] },
  ttl: { Session: 7 * 86400, Grant: 7 * 86400, AccessToken: 600, IdToken: 600, AuthorizationCode: 60, Interaction: 600 },
  interactions: { url: (_context, interaction) => `/interaction/${interaction.uid}` },
  async findAccount(_context, id) { // Returns only shared identity claims; the auth service has no access to tracker records.
    const account = store.account(id);
    if (!account) return undefined;
    return { accountId: account.id, async claims() { return { sub: account.id, preferred_username: account.username }; } };
  },
});
provider.proxy = process.env.AUTH_TRUST_PROXY === '1'; // Enable only behind the trusted reverse proxy, with the private service port firewalled.
const callback = provider.callback();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const csrfFor = uid => createHmac('sha256', config.cookieKeys[0]).update(`login:${uid}`).digest('base64url');
const formOrigins = [...new Set(config.clients.flatMap(client => client.redirect_uris.map(uri => new URL(uri).origin)))].join(' '); // Browser form redirects must be allowed to return to explicitly registered apps.

function view(response, uid, prompt, clientName, error = '') { // Renders a shared sign-in/consent screen without third-party scripts or user HTML interpolation.
  const login = prompt === 'login';
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formOrigins}; base-uri 'none'; frame-ancestors 'none'`, 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · lidoll.dev</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#50193755,transparent 65%),#1a0611;color:#fff0f4;font:16px 'Segoe UI',system-ui,sans-serif;display:grid;min-height:100dvh;place-items:center;padding:24px 0}main{background:linear-gradient(135deg,#ff96c809,transparent),#260b20;border:1px solid #fadadd;box-shadow:inset 0 0 0 2px #370f2d,inset 0 0 0 3px #d89aab,7px 7px 0 #ff96c819;padding:36px;width:min(460px,calc(100% - 32px))}h1{font:italic 900 32px/1.1 'Arial Black','Segoe UI Black',sans-serif;letter-spacing:-1px;margin:24px 0 15px}p{line-height:1.8;color:#cca9bd;font-size:14px}label{display:block;margin:18px 0 8px;font:12px Consolas,monospace;color:#fadadd}input,button{width:100%;font:inherit;border:1px solid #895571;border-radius:0;padding:13px;min-height:46px}input{background:#1a0611;color:#fff0f4}button{margin-top:24px;background:#ff96c8;border-color:#ff96c8;color:#1a0611;cursor:pointer;font:700 13px Consolas,monospace}button:hover{background:#fadadd}input:focus-visible,button:focus-visible{outline:2px solid #ffe66f;outline-offset:4px}.brand{color:#ff96c8;font:700 13px Consolas,monospace;letter-spacing:1.8px}.brand span{display:block;margin-top:8px;color:#cca9bd;font-size:10px;letter-spacing:.7px}.error{color:#ffabbc;border-left:2px solid #ffabbc;padding-left:12px}small{display:block;margin-top:24px;line-height:1.7;color:#cca9bd;font-size:12px}@media(max-width:400px){main{padding:28px 24px}h1{font-size:28px}}</style><main><div class="brand">✦ CHRYSALIS<span>IDENTITY GATEWAY // lidoll.dev accounts</span></div><h1>${login ? 'Identify yourself.' : 'Authorize access.'}</h1><p>${login ? `Sign in to ${escape(clientName)} with your shared lidoll.dev account.` : `${escape(clientName)} will receive your account ID and username. Your password stays with lidoll.dev accounts.`}</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post" action="/interaction/${escape(uid)}"><input type="hidden" name="csrf" value="${csrfFor(uid)}">${login ? '<label for="username">Username</label><input id="username" name="username" autocomplete="username" required maxlength="40"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128">' : ''}<button type="submit">${login ? 'Sign in' : 'Continue'}</button></form><small>${login ? 'Need an account or a password reset? Contact the lidoll.dev administrator.' : 'Each app manages access to its own data.'}</small></main></html>`);
}

async function formBody(request) { // Limits login form size before buffering secrets in memory.
  if (!(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid form.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error('Form too large.'); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export const authServer = http.createServer(async (request, response) => { // Delegates protocol validation and token issuance to the maintained OIDC provider.
  const path = new URL(request.url, config.issuer).pathname;
  const match = /^\/interaction\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!match) return callback(request, response);
  try {
    const details = await provider.interactionDetails(request, response);
    if (details.uid !== match[1]) throw new Error('Invalid interaction.');
    const client = config.clients.find(item => item.client_id === details.params.client_id);
    if (!client || !['login', 'consent'].includes(details.prompt.name)) throw new Error('Unsupported interaction.');
    if (request.method === 'GET') return view(response, details.uid, details.prompt.name, client.client_name ?? client.client_id);
    if (request.method !== 'POST' || request.headers.origin !== config.issuer) throw new Error('Invalid origin.');
    const form = await formBody(request);
    const supplied = Buffer.from(form.get('csrf') ?? ''), expected = Buffer.from(csrfFor(details.uid));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid form token.');
    if (details.prompt.name === 'login') {
      const username = (form.get('username') ?? '').trim().toLowerCase(), password = form.get('password') ?? '';
      const address = provider.proxy ? String(request.headers['x-real-ip'] ?? request.socket.remoteAddress) : request.socket.remoteAddress;
      const ipAllowed = store.rateLimit(`ip:${address}`, 50), userAllowed = store.rateLimit(`user:${username}`, 10);
      if (!ipAllowed || !userAllowed) return view(response, details.uid, 'login', client.client_name, 'Too many attempts. Try again in 15 minutes.');
      if (username.length > 40 || password.length > 128) throw new Error('Invalid input length.');
      const account = await store.verify(username, password);
      if (!account) return view(response, details.uid, 'login', client.client_name, 'Username or password was not accepted.');
      return await provider.interactionFinished(request, response, { login: { accountId: account.id } }, { mergeWithLastSubmission: false });
    }
    let grant = details.grantId ? await provider.Grant.find(details.grantId) : null;
    grant ??= new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });
    if (details.prompt.details.missingOIDCScope) grant.addOIDCScope(details.prompt.details.missingOIDCScope.join(' '));
    if (details.prompt.details.missingOIDCClaims) grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
    const grantId = await grant.save();
    return await provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true });
  } catch {
    if (!response.headersSent) { response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Sign-in expired or could not be completed. Return to your app and try signing in again.'); }
  }
});
authServer.requestTimeout = 15000;
authServer.headersTimeout = 10000;
const cleanup = setInterval(() => store.cleanup(), 3600000);
cleanup.unref();
authServer.on('close', () => { clearInterval(cleanup); store.close(); });
authServer.listen(Number(process.env.AUTH_PORT ?? 4180), process.env.AUTH_HOST ?? '127.0.0.1', () => console.log(`lidoll.dev accounts listening on port ${authServer.address().port}; issuer ${config.issuer}`));
