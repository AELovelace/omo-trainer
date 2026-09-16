import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';
import { checkedUrl } from '../auth/config.mjs';
import {SESSION_IDLE_SECONDS} from './sessions.mjs';

export function cookie(request, name) { // Reads only the named cookie; session credentials never appear in URLs or JavaScript storage.
  return (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function createLogin(database, base) { // Acts as an OIDC relying party; future apps can follow this same issuer/client/callback contract.
  if (process.env.NODE_ENV === 'production' && (!process.env.PUBLIC_ORIGIN || !process.env.OIDC_ISSUER)) throw new Error('Set PUBLIC_ORIGIN and OIDC_ISSUER for production.');
  const origin = checkedUrl(process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4173').origin;
  const issuer = checkedUrl(process.env.OIDC_ISSUER ?? 'http://127.0.0.1:4180');
  if (process.env.NODE_ENV === 'production' && (!origin.startsWith('https:') || issuer.protocol !== 'https:')) throw new Error('Production app and auth origins require HTTPS.');
  const secure = origin.startsWith('https:');
  const sessionName = secure ? '__Secure-little_log' : 'little_log';
  const loginName = secure ? '__Secure-little_log_login' : 'little_log_login';
  let configuration;
  async function configured() { // Discovers endpoints once, retrying discovery after outages instead of permanently caching a failure.
    if (!configuration) {
      configuration = oidc.discovery(issuer, process.env.OIDC_CLIENT_ID ?? 'little-log', undefined, oidc.None(), {
        execute: [...(issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks],
      }).catch(error => { configuration = null; throw error; });
    }
    return configuration;
  }
  const setCookie = (name, value, age) => `${name}=${value}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const redirect = (response, location, cookies = []) => { response.writeHead(303, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' }); response.end(); };
  return {
    origin,
    session(request,response) { // Refresh the persistent HttpOnly cookie to match the server expiry; credentials never enter browser storage.
      const token=cookie(request,sessionName),session=database.session(token,{renew:Boolean(response)});
      if(session&&response){
        const remaining=Math.max(0,Math.floor((session.expiresAt-database.sessionNow())/1000));
        const previous=response.getHeader('Set-Cookie')??[];
        response.setHeader('Set-Cookie',[...(Array.isArray(previous)?previous:[previous]),setCookie(sessionName,token,remaining)]);
      }
      return session;
    },
    logout(request, response) { // Ends this application's session without relying on inaccessible HttpOnly cookies in frontend code.
      database.deleteSession(cookie(request, sessionName));
      response.setHeader('Set-Cookie', setCookie(sessionName, '', 0));
    },
    async route(request, response, route) {
      try {
        if (request.method !== 'GET') { response.writeHead(405); return response.end(); }
        if (route === 'login' || route === 'register') {
          const config = await configured();
          const attempt = randomBytes(32).toString('base64url');
          const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
          const destination = new URL(request.url, origin).searchParams.get('returnTo');
          const returnTo = ['growth-chart', 'admin', 'stickers', 'coins', 'game-wallet', 'game-wallet-embedded', 'social', 'post', 'feed', 'friends', 'messages', 'activity', 'profile'].includes(destination) ? destination : 'settings';
          database.saveLogin(attempt, { verifier, state, nonce, returnTo }); // Keep an allowlisted destination server-side, including the chart view inside Little Log.
          const location = oidc.buildAuthorizationUrl(config, { redirect_uri: `${origin}${base}auth/callback`, scope: 'openid profile', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
            ...(route === 'register' ? { screen_hint: 'signup', prompt: 'login' } : new URL(request.url, origin).searchParams.get('reauth') === '1' ? { prompt: 'login' } : {}), // Registration keeps the same PKCE, state, nonce, and exact callback protections as sign-in.
          });
          return redirect(response, location.href, [setCookie(loginName, attempt, 600)]);
        }
        if (route === 'callback') {
          const attempt = database.takeLogin(cookie(request, loginName));
          if (!attempt) throw new Error('No matching login attempt.');
          const config = await configured();
          const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url, origin), { pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce, idTokenExpected: true });
          const claims = tokens.claims();
          if (!claims?.sub) throw new Error('Missing subject.');
          const profile = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
          const account = database.ensureParticipant(claims.iss, claims.sub, profile.preferred_username);
          database.deleteSession(cookie(request, sessionName));
          return redirect(response, ['social','post','feed','friends','messages','activity','profile'].includes(attempt.returnTo) ? `${base}#${attempt.returnTo}` : attempt.returnTo === 'game-wallet-embedded' ? `${base}api/lidollcoin/browser/connect?view=embedded` : attempt.returnTo === 'game-wallet' ? `${base}api/lidollcoin/browser/connect` : attempt.returnTo === 'coins' ? `${base}coins/` : attempt.returnTo === 'growth-chart' ? `${base}#potty-chart` : attempt.returnTo === 'stickers' ? `${base}#stickers` : attempt.returnTo === 'admin' ? `${base}admin/` : `${base}#settings`, [setCookie(sessionName, database.createSession(account.id), SESSION_IDLE_SECONDS), setCookie(loginName, '', 0)]);
        }
        response.writeHead(404); response.end();
      } catch (error) {
        console.error(`Sign-in ${route} failed:`, error.cause?.code ?? error.code ?? error.name, error.message); // Records the cause in the service journal; session cookies and tokens never appear in these fields.
        if (response.headersSent) return response.end();
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Sign-in could not be completed. Return to Little Log and try again. Your locally saved entries are unchanged.');
      }
    },
  };
}
