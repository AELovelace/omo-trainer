import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authDirectory } from './store.mjs';

export function checkedUrl(value) { // Allows HTTPS in production and plain HTTP only for loopback development.
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS URLs, or loopback HTTP for local development.');
  return url;
}

export function loadAuthConfig(directory = authDirectory()) { // Persists signing and cookie keys so service restarts do not break existing identities or sessions.
  if (process.env.NODE_ENV === 'production' && !process.env.AUTH_ISSUER) throw new Error('Set AUTH_ISSUER to the public HTTPS auth origin.');
  const issuer = checkedUrl(process.env.AUTH_ISSUER ?? 'http://127.0.0.1:4180').origin;
  if (process.env.NODE_ENV === 'production' && !issuer.startsWith('https:')) throw new Error('Production authentication requires HTTPS.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secretsFile = resolve(directory, 'secrets.json');
  if (!existsSync(secretsFile)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'RS256', use: 'sig' };
    writeFileSync(secretsFile, JSON.stringify({ jwks: { keys: [key] }, cookieKeys: [randomBytes(48).toString('base64url')] }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const clientsFile = resolve(directory, 'clients.json');
  if (!existsSync(clientsFile)) {
    const tracker = process.env.TRACKER_REDIRECT_URI ?? (issuer.startsWith('https:') ? 'https://lidoll.dev/tracker/auth/callback' : 'http://127.0.0.1:4173/tracker/auth/callback');
    writeFileSync(clientsFile, JSON.stringify([{ client_id: 'little-log', client_name: 'Little Log', redirect_uris: [checkedUrl(tracker).href], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }], null, 2), { flag: 'wx', mode: 0o600 });
  }
  const clients = JSON.parse(readFileSync(clientsFile, 'utf8'));
  if (!Array.isArray(clients) || !clients.length) throw new Error('Configure at least one OIDC client.');
  for (const client of clients) {
    if (!/^[a-z0-9_-]{1,80}$/.test(client.client_id) || !Array.isArray(client.redirect_uris) || !client.redirect_uris.length) throw new Error('Invalid OIDC client configuration.');
    for (const uri of client.redirect_uris) checkedUrl(uri);
  }
  return { issuer, clients, ...JSON.parse(readFileSync(secretsFile, 'utf8')) };
}
