import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { openAuthStore, authDirectory } from '../auth/store.mjs';
import { loadAuthConfig, checkedUrl } from '../auth/config.mjs';

const [command, argument, redirectUri] = process.argv.slice(2);
const commands = ['init', 'create', 'reset-password', 'disable', 'list', 'add-client', 'backup'];
if (!commands.includes(command) || (!['init', 'list'].includes(command) && !argument)) {
  console.log('Usage: node scripts/auth-admin.mjs init | create <username> | reset-password <username> | disable <username> | list | add-client <client-id> <redirect-uri> | backup <new-directory>');
  process.exit(1);
}
loadAuthConfig();
const store = openAuthStore();
try {
  if (command === 'init') console.log('Shared OIDC signing keys, clients, and database initialized.');
  else if (command === 'list') console.log(JSON.stringify(store.list(), null, 2));
  else if (command === 'disable') { store.disable(argument); console.log('Account disabled; existing app sessions expire within their configured lifetime.'); }
  else if (command === 'backup') {
    const destination = resolve(argument);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await mkdir(destination, { mode: 0o700 }); // Requires a new backup directory and never overwrites the identity service's live files.
    for (const name of ['secrets.json', 'clients.json']) await copyFile(resolve(authDirectory(), name), resolve(destination, name));
    await store.backup(resolve(destination, 'auth.sqlite'));
    console.log(`Identity database, signing keys, and client configuration backed up to ${destination}`);
  }
  else if (command === 'add-client') {
    if (!/^[a-z0-9_-]{1,80}$/.test(argument) || !redirectUri) throw new Error('Supply a simple client ID and an exact callback URL.');
    const file = resolve(authDirectory(), 'clients.json');
    const clients = JSON.parse(await readFile(file, 'utf8'));
    if (clients.some(client => client.client_id === argument)) throw new Error('Client ID already exists. Edit its existing redirect_uris instead.');
    clients.push({ client_id: argument, client_name: argument, redirect_uris: [checkedUrl(redirectUri).href], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' });
    await writeFile(file, JSON.stringify(clients, null, 2), { mode: 0o600 });
    console.log('OIDC client registered. Restart the auth service to load the new client.');
  } else {
    const password = randomBytes(24).toString('base64url'); // Generates a strong secret without accepting passwords in shell arguments or command history.
    await store.setPassword(argument, password, command === 'create');
    console.log(JSON.stringify({ username: argument, password }, null, 2));
  }
} catch (error) { console.error(error.code === 'ERR_SQLITE_ERROR' ? 'Account or client could not be updated; it may already exist.' : error.message); process.exitCode = 1; }
finally { store.close(); }
