import {walletIdentity,walletScopes} from '../auth/wallet-identity.mjs';
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Provider from 'oidc-provider';
import { openAuthStore, AccountInputError } from '../auth/store.mjs';
import { loadAuthConfig } from '../auth/config.mjs';
import { authPage } from '../auth/views.mjs';

const config = loadAuthConfig();
const store = openAuthStore();
const secure = config.issuer.startsWith('https:');
export const provider = new Provider(config.issuer, {
  clients: config.clients.map(client=>({...client,scope:client.scope??['openid','profile',...(client.client_id==='lidollbot'?walletScopes:[])].join(' ')})),
  scopes:['openid','profile',...walletScopes], adapter: store.Adapter, jwks: config.jwks,
  cookies: { keys: config.cookieKeys, long: { secure, sameSite: 'lax' }, short: { secure, sameSite: 'lax' } },
  features: { devInteractions: { enabled: false } },
  pkce: { required: () => true },
  extraParams: ['screen_hint'], // Lets registered apps request the signup screen while retaining the normal OIDC interaction.
  claims: { openid: ['sub'], profile: ['preferred_username'] },
  ttl: { Session: 7 * 86400, Grant: 7 * 86400, AccessToken: 600, IdToken: 600, AuthorizationCode: 60, Interaction: 600 },
  interactions: { url: (_context, interaction) => `/interaction/${interaction.uid}${interaction.prompt.name === 'login' && interaction.params.screen_hint === 'signup' ? '/register' : ''}` },
  async findAccount(_context, id) { // Returns only shared identity claims; the auth service has no access to tracker records.
    const account = store.account(id);
    if (!account) return undefined;
    return { accountId: account.id, async claims() { return { sub: account.id, preferred_username: account.username }; } };
  },
});
provider.proxy = process.env.AUTH_TRUST_PROXY === '1'; // Enable only behind the trusted reverse proxy, with the private service port firewalled.
const callback = provider.callback();
const csrfFor = (uid, action = 'login') => createHmac('sha256', config.cookieKeys[0]).update(`${action}:${uid}`).digest('base64url');
const registrationsInFlight = new Set(); // Bounds concurrent password hashing and blocks double submissions within one interaction.
const formOrigins = [...new Set(config.clients.flatMap(client => client.redirect_uris.map(uri => new URL(uri).origin)))].join(' '); // Browser form redirects must be allowed to return to explicitly registered apps.

function view(response, uid, mode, clientName, error = '', username = '', status = 200, scope = '') { // Keeps every identity form uncached and protected by the same response policy.
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formOrigins}; base-uri 'none'; frame-ancestors 'none'`, 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
  response.end(authPage({ uid, mode, clientName, csrf: csrfFor(uid, mode === 'register' ? 'register' : 'login'), error, username, scope }));
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
  if(path==='/wallet/identity') { // Private back-channel introspection; no browser cookies or identity supplied by the calling app are trusted.
    response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json');
    if(request.method!=='GET'){response.writeHead(405);return response.end(JSON.stringify({error:'method_not_allowed'}));}
    const secret=/^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization??'')?.[1];
    try {return response.end(JSON.stringify(await walletIdentity(provider,store,config.issuer,secret)));}
    catch {response.writeHead(401);return response.end(JSON.stringify({error:'invalid_token'}));}
  }
  const match = /^\/interaction\/([A-Za-z0-9_-]+)(\/register)?$/.exec(path);
  if (!match) return callback(request, response);
  try {
    const details = await provider.interactionDetails(request, response);
    if (details.uid !== match[1]) throw new Error('Invalid interaction.');
    const client = config.clients.find(item => item.client_id === details.params.client_id);
    if (!client || !['login', 'consent'].includes(details.prompt.name)) throw new Error('Unsupported interaction.');
    const register = Boolean(match[2]);
    if (details.result || (register && details.prompt.name !== 'login')) throw new Error('Interaction already completed or unsupported.');
    const clientName = client.client_name ?? client.client_id;
    if (request.method === 'GET') return view(response, details.uid, register ? 'register' : details.prompt.name, clientName, '', '', 200, details.params.scope);
    if (request.method !== 'POST' || request.headers.origin !== config.issuer) throw new Error('Invalid origin.');
    const form = await formBody(request);
    const supplied = Buffer.from(form.get('csrf') ?? ''), expected = Buffer.from(csrfFor(details.uid, register ? 'register' : 'login'));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid form token.');
    if (details.prompt.name === 'login') {
      const username = (form.get('username') ?? '').trim().toLowerCase(), password = form.get('password') ?? '';
      const address = provider.proxy ? String(request.headers['x-real-ip'] ?? request.socket.remoteAddress) : request.socket.remoteAddress;
      if (register) {
        const ipAllowed = store.rateLimit(`registration:ip:${address}`, 10), globalAllowed = store.rateLimit('registration:global', 60);
        if (!ipAllowed || !globalAllowed || registrationsInFlight.size >= 4) {
          response.setHeader('Retry-After', '900');
          return view(response, details.uid, 'register', clientName, 'Registration is busy or has had too many attempts. Try again in 15 minutes.', username.slice(0, 40), 429);
        }
        if (registrationsInFlight.has(details.uid)) return view(response, details.uid, 'register', clientName, 'Your registration is already being processed.', username.slice(0, 40), 409);
        if (password !== form.get('confirmPassword')) return view(response, details.uid, 'register', clientName, 'Passwords do not match. Enter them again.', username.slice(0, 40), 400);
        registrationsInFlight.add(details.uid);
        try {
          const account = await store.setPassword(username, password, true);
          response.setHeader('Cache-Control', 'no-store');
          return await provider.interactionFinished(request, response, { login: { accountId: account.id } }, { mergeWithLastSubmission: false });
        } catch (error) {
          if (error instanceof AccountInputError) return view(response, details.uid, 'register', clientName, error.message, username.slice(0, 40), 400);
          throw error;
        } finally { registrationsInFlight.delete(details.uid); }
      }
      const ipAllowed = store.rateLimit(`ip:${address}`, 50), userAllowed = store.rateLimit(`user:${username}`, 10);
      if (!ipAllowed || !userAllowed) return view(response, details.uid, 'login', client.client_name, 'Too many attempts. Try again in 15 minutes.');
      if (username.length > 40 || password.length > 128) throw new Error('Invalid input length.');
      const account = await store.verify(username, password);
      if (!account) return view(response, details.uid, 'login', client.client_name, 'Username or password was not accepted.');
      return await provider.interactionFinished(request, response, { login: { accountId: account.id } }, { mergeWithLastSubmission: false });
    }
    if(form.get('decision')==='deny')return await provider.interactionFinished(request,response,{error:'access_denied',error_description:'Access declined.'},{mergeWithLastSubmission:false}); // Denial grants neither identity nor wallet access.
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
