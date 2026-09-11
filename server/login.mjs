import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';
import { checkedUrl } from '../auth/config.mjs';

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
    session: request => database.session(cookie(request, sessionName)),
    logout(request, response) { // Ends this application's session without relying on inaccessible HttpOnly cookies in frontend code.
      database.deleteSession(cookie(request, sessionName));
      response.setHeader('Set-Cookie', setCookie(sessionName, '', 0));
    },
    async route(request, response, route) {
      try {
        if (request.method !== 'GET') { response.writeHead(405); return response.end(); }
        if (route === 'login') {
          const config = await configured();
          const attempt = randomBytes(32).toString('base64url');
          const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
          database.saveLogin(attempt, { verifier, state, nonce });
          const location = oidc.buildAuthorizationUrl(config, { redirect_uri: `${origin}${base}auth/callback`, scope: 'openid profile', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
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
          return redirect(response, `${base}#settings`, [setCookie(sessionName, database.createSession(account.id), 3600), setCookie(loginName, '', 0)]);
        }
        response.writeHead(404); response.end();
      } catch {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Sign-in could not be completed. Return to Little Log and try again. Your locally saved entries are unchanged.');
      }
    },
  };
}
