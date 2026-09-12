import { run } from './command.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, renameSync, symlinkSync, unlinkSync, cpSync, openSync, closeSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { isIP } from 'node:net';
import { DEFAULTS, validateConfig, validateEnvironment, firewallRules, serviceUnit, activateRelease, fetchBranch } from './release.mjs';

const ROOT = '/opt/lidoll';
const CONFIG = '/etc/lidoll';
const DATA = '/var/lib/lidoll';
const BACKUPS = '/var/backups/lidoll';
const BUILDER = 'lidoll-deploy';
const MIRROR = '/var/lib/lidoll-deploy/repository.git';
const NODE = '/usr/bin/node-24';
const NPM = '/usr/lib/node_modules_24/npm/bin/npm-cli.js';
const units = ['lidoll-tracker.service', 'lidoll-auth.service'];
const currentLink = join(ROOT, 'current');
const configFile = join(CONFIG, 'deploy.json');
const lockFile = join(CONFIG, 'deployment.lock');
const options = {};
let checkOnly = false;
const [command, ...args] = process.argv.slice(2);

function safeDirectory(path, mode = 0o755) { // Refuses symlinked deployment directories before privileged writes.
  let cursor = resolve(path);
  while (cursor !== '/') {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing a symlinked deployment directory: ${cursor}`);
    cursor = dirname(cursor);
  }
  mkdirSync(path, { recursive: true, mode });
}

function writeAtomic(path, content, mode = 0o600) { // Replaces only the intended configuration file; original content survives interrupted writes.
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to overwrite a symlink: ${path}`);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode });
  renameSync(temp, path);
}

function createUser(user, home) { // Creates dedicated service/build identities without changing an existing user's shell or home.
  try { run('/usr/bin/id', ['-u', user], { capture: true }); }
  catch { run('/usr/sbin/useradd', ['--system', '--user-group', '--create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', user]); }
}

function setup(config) { // Installs stable directories and env files once, leaving existing databases, signing keys, and settings intact.
  for (const path of [ROOT, join(ROOT, 'releases'), join(ROOT, 'staging'), CONFIG, DATA]) safeDirectory(path);
  safeDirectory(BACKUPS, 0o700);
  createUser(BUILDER, '/var/lib/lidoll-deploy');
  safeDirectory('/var/lib/lidoll-deploy', 0o700);
  run('/usr/bin/chown', [BUILDER + ':' + BUILDER, '/var/lib/lidoll-deploy']);
  for (const name of ['tracker', 'auth']) {
    const user = `lidoll-${name}`;
    createUser(user, join(DATA, name));
    safeDirectory(join(DATA, name), 0o700);
    run('/usr/bin/chown', ['-R', `${user}:${user}`, join(DATA, name)]);
    run('/usr/bin/chmod', ['700', join(DATA, name)]);
  }
  const tracker = `NODE_ENV=production\nHOST=${config.bindAddress}\nPORT=4173\nBASE_PATH=/tracker/\nPUBLIC_ORIGIN=${config.publicOrigin}\nOIDC_ISSUER=${config.authOrigin}\nOIDC_CLIENT_ID=little-log\nDATA_DIR=${DATA}/tracker\n`;
  const auth = `NODE_ENV=production\nAUTH_HOST=${config.bindAddress}\nAUTH_PORT=4180\nAUTH_ISSUER=${config.authOrigin}\nAUTH_TRUST_PROXY=1\nAUTH_DATA_DIR=${DATA}/auth\nTRACKER_REDIRECT_URI=${config.publicOrigin}/tracker/auth/callback\n`;
  for (const [name, content] of [['tracker', tracker], ['auth', auth]]) {
    const file = join(CONFIG, `${name}.env`);
    if (!existsSync(file)) writeFileSync(file, content, { flag: 'wx', mode: 0o640 });
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Refusing a symlinked env file: ${file}`);
    run('/usr/bin/chown', [`root:lidoll-${name}`, file]);
    chmodSync(file, 0o640);
  }
}

function readEnvironment() { // Rejects settings that would escape the persistent backup or service-isolation paths.
  const environment = validateEnvironment(readFileSync(join(CONFIG, 'tracker.env'), 'utf8'), readFileSync(join(CONFIG, 'auth.env'), 'utf8'));
  const clientFile = join(DATA, 'auth', 'clients.json');
  if (existsSync(clientFile)) {
    const clients = JSON.parse(readFileSync(clientFile, 'utf8'));
    const client = clients.find(item => item.client_id === environment.tracker.OIDC_CLIENT_ID);
    if (!client?.redirect_uris?.includes(environment.auth.TRACKER_REDIRECT_URI)) throw new Error('The existing auth clients.json does not register this tracker callback. Update that registration explicitly; the installer will not overwrite auth configuration.');
  }
  return environment;
}

function installUnits(verifyOnly = false) { // Checks existing units before changing data ownership; updates preserve operator-managed unit files.
  for (const name of ['tracker', 'auth']) {
    const file = `/etc/systemd/system/lidoll-${name}.service`;
    const content = serviceUnit({ name, user: `lidoll-${name}`, script: `scripts/${name === 'auth' ? 'auth-server' : 'serve'}.mjs`, dataDirectory: `${DATA}/${name}` });
    if (existsSync(file) && readFileSync(file, 'utf8') !== content) throw new Error(`Existing ${file} differs from the generated unit. Review it instead of overwriting an existing service.`);
    if (!verifyOnly && !existsSync(file)) writeFileSync(file, content, { flag: 'wx', mode: 0o644 });
  }
  if (!verifyOnly) run('/usr/bin/systemctl', ['daemon-reload']);
}

function configureFirewall(config, environment) { // Adds source-specific access only to an already-active firewall; it never enables a new firewall or opens the ports globally.
  if (!config.proxyIp) { console.log('No --proxy-ip supplied. Existing firewall policy was left unchanged.'); return; }
  run('/usr/bin/firewall-cmd', ['--state']);
  for (const rule of firewallRules(config.proxyIp, [environment.tracker.PORT, environment.auth.AUTH_PORT])) {
    run('/usr/bin/firewall-cmd', [`--zone=${config.firewallZone}`, '--permanent', `--add-rich-rule=${rule}`]);
    run('/usr/bin/firewall-cmd', [`--zone=${config.firewallZone}`, `--add-rich-rule=${rule}`]);
  }
}

function fetchCommit(config) { // Fetches only the configured GitHub branch and resolves it to an immutable commit before staging.
  console.log(`Fetching ${config.repo} (${config.branch})…`);
  return fetchBranch({ repository: config.repo, branch: config.branch, mirror: MIRROR, exists: existsSync(MIRROR),
    git: arguments_ => run('/usr/bin/git', arguments_, { user: BUILDER, capture: true }),
  });
}

function previousRelease() { // Allows switching only the deployment's own current symlink, never an unrelated directory or checkout.
  try {
    if (!lstatSync(currentLink).isSymbolicLink()) throw new Error('The current release path must be a symlink managed by this installer.');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const target = realpathSync(currentLink);
  if (dirname(target) !== join(ROOT, 'releases')) throw new Error('The current symlink points outside the managed releases directory.');
  return target;
}

function stageRelease(commit) { // Installs and tests a fresh checkout as an unprivileged builder while the previous release keeps running.
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 12)}`;
  const stage = join(ROOT, 'staging', id);
  mkdirSync(stage, { mode: 0o755 });
  run('/usr/bin/chown', [`${BUILDER}:${BUILDER}`, stage]);
  run('/usr/bin/git', ['clone', '--no-hardlinks', '--no-checkout', MIRROR, stage], { user: BUILDER });
  run('/usr/bin/git', ['checkout', '--detach', commit], { user: BUILDER, cwd: stage });
  for (const name of ['package-lock.json', 'scripts/serve.mjs', 'scripts/auth-server.mjs', 'deploy/fedora.mjs', 'deploy/command.mjs', 'deploy/fedora-update.sh']) {
    if (!existsSync(join(stage, name))) throw new Error(`Fetched commit is missing ${name}. Push the complete deployment changes to GitHub first.`);
  }
  console.log('Installing pinned packages and testing the staged release…');
  run(NODE, [NPM, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { user: BUILDER, cwd: stage });
  const tests = readdirSync(join(stage, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
  if (!tests.length) throw new Error('The candidate release has no regression tests.');
  run(NODE, ['--test', ...tests], { user: BUILDER, cwd: stage });
  for (const script of ['scripts/serve.mjs', 'scripts/auth-server.mjs', 'app.js']) run(NODE, ['--check', script], { user: BUILDER, cwd: stage });
  const workerFile = join(stage, 'sw.js');
  if (!lstatSync(workerFile).isFile()) throw new Error('The service worker must be a regular file, not a symlink.');
  const worker = readFileSync(workerFile, 'utf8');
  if (!/const CACHE = `little-log-[^`]+`/.test(worker)) throw new Error('Cannot stamp the service-worker cache. Review its format before deployment.');
  writeFileSync(workerFile, worker.replace(/const CACHE = `little-log-[^`]+`/, 'const CACHE = `little-log-' + commit + '-${self.registration.scope}`'));
  writeFileSync(join(stage, '.release.json'), JSON.stringify({ commit, deployedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  run('/usr/bin/chown', ['-R', 'root:root', stage]);
  run('/usr/bin/chmod', ['-R', 'u=rwX,go=rX', stage]);
  const release = join(ROOT, 'releases', id);
  renameSync(stage, release);
  run('/usr/sbin/restorecon', ['-R', release]);
  return release;
}

function switchRelease(target) { // Atomically switches the managed code symlink on the same filesystem.
  if (!target) { if (lstatSync(currentLink).isSymbolicLink()) unlinkSync(currentLink); return; }
  const temp = join(ROOT, `.current-${randomUUID()}`);
  symlinkSync(target, temp);
  renameSync(temp, currentLink);
}

function backupData(previous) { // Copies both stopped services' complete SQLite/WAL state, auth keys, clients, and env files to a new private backup.
  const destination = join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(destination, { mode: 0o700 });
  for (const name of ['tracker', 'auth']) cpSync(join(DATA, name), join(destination, name), { recursive: true, errorOnExist: true, force: false });
  cpSync(CONFIG, join(destination, 'config'), { recursive: true, filter: source => source !== lockFile });
  writeFileSync(join(destination, 'release.json'), JSON.stringify({ previous, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Pre-deployment backup: ${destination}`);
  return destination;
}

async function health(release, environment) { // Confirms both managed processes run from the intended release and return the expected local HTTP responses.
  const address = host => host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : isIP(host) === 6 ? `[${host}]` : host;
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      for (const unit of units) {
        run('/usr/bin/systemctl', ['is-active', '--quiet', unit], { capture: true });
        const pid = run('/usr/bin/systemctl', ['show', '--property=MainPID', '--value', unit], { capture: true });
        if (!/^[1-9]\d*$/.test(pid) || realpathSync(`/proc/${pid}/cwd`) !== release) throw new Error(`${unit} is not running the intended release.`);
      }
      const tracker = await fetch(`http://${address(environment.tracker.HOST)}:${environment.tracker.PORT}${environment.tracker.BASE_PATH}api/session`, { signal: AbortSignal.timeout(2000) });
      if (tracker.status !== 401 || !(await tracker.json()).error) throw new Error('Tracker API did not return its expected unauthenticated response.');
      const auth = await fetch(`http://${address(environment.auth.AUTH_HOST)}:${environment.auth.AUTH_PORT}/.well-known/openid-configuration`, {
        headers: { Host: new URL(environment.auth.AUTH_ISSUER).host, 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(2000),
      });
      if (!auth.ok || (await auth.json()).issuer !== environment.auth.AUTH_ISSUER) throw new Error('Auth discovery returned an unexpected issuer.');
      return;
    } catch (error) { lastError = error; await new Promise(resolveWait => setTimeout(resolveWait, 1000)); }
  }
  throw new Error(`Service health checks failed: ${lastError.message}`);
}

async function main() { // Separates preparation from the brief stop/backup/switch/start window and serializes deploys with an exclusive lock.
  if (args.includes('--help') || args.includes('-h')) { console.log('Fedora deployment: install [--repo URL --branch NAME --bind-address IP --proxy-ip IP --firewall-zone ZONE --public-origin URL --auth-origin URL]\nFedora update: update [--check]\nSaved configuration: /etc/lidoll/deploy.json'); return; }
  if (process.platform !== 'linux' || !existsSync('/etc/fedora-release') || process.getuid?.() !== 0) throw new Error('Run this program as root on Fedora with systemd.');
  if (!['install', 'update'].includes(command)) throw new Error('Choose install or update.');
  for (let index = 0; index < args.length; index++) {
    if (command === 'update' && args[index] === '--check') { checkOnly = true; continue; }
    const keys = { '--repo': 'repo', '--branch': 'branch', '--bind-address': 'bindAddress', '--proxy-ip': 'proxyIp', '--firewall-zone': 'firewallZone', '--public-origin': 'publicOrigin', '--auth-origin': 'authOrigin' };
    const key = keys[args[index]];
    if (command !== 'install' || !key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = args[++index];
  }
  if (!existsSync('/run/systemd/system') || !existsSync(NODE) || !existsSync(NPM)) throw new Error('Install Fedora Node 24/npm and run under systemd; use fedora-deploy.sh first.');
  safeDirectory(CONFIG);
  let lock;
  try { lock = openSync(lockFile, 'wx', 0o600); writeFileSync(lock, String(process.pid)); }
  catch { throw new Error(`Another deployment may be running. Inspect ${lockFile} and its PID before removing a stale lock.`); }
  try {
    if (command === 'update' && !existsSync(configFile)) throw new Error('Run fedora-deploy.sh once before updating.');
    const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
    if (saved && Object.keys(options).length) throw new Error('Deployment is already configured. Edit /etc/lidoll/deploy.json or the env files explicitly instead of passing replacement install flags.');
    const config = validateConfig(saved ?? { ...DEFAULTS, ...options });
    if (command === 'install') {
      installUnits(true);
      setup(config);
      if (!saved) writeAtomic(configFile, JSON.stringify(config, null, 2));
      installUnits();
    }
    const environment = readEnvironment();
    if (command === 'install') configureFirewall(config, environment);
    const previous = previousRelease();
    if (command === 'update' && !previous) throw new Error('No active release. Run the deployment script to complete the initial installation.');
    if (previous) {
      for (const file of ['tracker/little-log.sqlite', 'tracker/market.sqlite', 'auth/auth.sqlite', 'auth/secrets.json', 'auth/clients.json']) {
        const path = join(DATA, file);
        if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Persistent data is missing or symlinked: ${path}. Restore or verify it before updating; new identities will not be generated over missing data.`);
      }
    }
    const commit = fetchCommit(config);
    const previousCommit = previous && JSON.parse(readFileSync(join(previous, '.release.json'), 'utf8')).commit;
    console.log(`GitHub ${config.branch}: ${commit}\nInstalled: ${previousCommit ?? 'none'}`);
    if (checkOnly || commit === previousCommit) { console.log(checkOnly ? 'Check complete; services and installed files were not changed.' : 'Already up to date; no restart needed.'); return; }
    const release = stageRelease(commit);
    run('/usr/sbin/restorecon', ['-R', CONFIG, DATA, BACKUPS]);
    await activateRelease({
      hasPrevious: Boolean(previous),
      stop: async () => run('/usr/bin/systemctl', ['stop', ...units]),
      backup: async () => backupData(previous),
      switchToNew: async () => switchRelease(release),
      restorePrevious: async () => switchRelease(previous),
      start: async () => run('/usr/bin/systemctl', ['start', 'lidoll-auth.service', 'lidoll-tracker.service']),
      health: () => health(release, environment),
      previousHealth: () => health(previous, environment),
    });
    run('/usr/bin/systemctl', ['enable', ...units]);
    console.log(`Deployed ${commit}.\nUpdate next time: sudo bash /opt/lidoll/current/deploy/fedora-update.sh\nService logs: journalctl -u lidoll-tracker -u lidoll-auth -f\nConfigure the separate reverse proxy using the Nginx snippets in ${release}/deploy/.`);
  } finally { closeSync(lock); unlinkSync(lockFile); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
