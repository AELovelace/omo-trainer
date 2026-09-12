import { isIP } from 'node:net';
import { parseEnv } from 'node:util';

export const DEFAULTS = Object.freeze({ repo: 'https://github.com/AELovelace/omo-trainer.git', branch: 'main', bindAddress: '10.1.1.23', proxyIp: '', firewallZone: 'public', publicOrigin: 'https://lidoll.dev', authOrigin: 'https://auth.sadgirlsclub.wtf' });

export function validateConfig(value) { // Restricts values before they enter Git arguments, env files, systemd units, or firewall rules.
  const config = { ...DEFAULTS, ...value };
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(config.repo)) throw new Error('Use a GitHub HTTPS or git@github.com repository URL without embedded credentials.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(config.branch) || config.branch.includes('..') || config.branch.endsWith('/') || config.branch.endsWith('.lock')) throw new Error('Use a plain Git branch name.');
  if (!isIP(config.bindAddress)) throw new Error('Bind address must be an IP address.');
  if (config.proxyIp && !isIP(config.proxyIp)) throw new Error('Proxy IP must be one IP address, without a subnet range.');
  if (!/^[A-Za-z0-9_-]+$/.test(config.firewallZone)) throw new Error('Invalid firewalld zone.');
  for (const key of ['publicOrigin', 'authOrigin']) {
    const url = new URL(config[key]);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${key} must be an HTTPS origin, without a path or credentials.`);
    config[key] = url.origin;
  }
  return config;
}

export function validateEnvironment(trackerText, authText) { // Checks the persisted settings that will actually run, rather than assuming CLI defaults overwrote them.
  const tracker = parseEnv(trackerText), auth = parseEnv(authText);
  for (const [name, env] of [['tracker', tracker], ['auth', auth]]) {
    if (env.NODE_ENV !== 'production') throw new Error(`${name}.env must use NODE_ENV=production.`);
  }
  validateConfig({ bindAddress: tracker.HOST, publicOrigin: tracker.PUBLIC_ORIGIN, authOrigin: auth.AUTH_ISSUER });
  if (!isIP(auth.AUTH_HOST)) throw new Error('AUTH_HOST must be an IP address.');
  for (const port of [tracker.PORT, auth.AUTH_PORT]) if (!/^\d+$/.test(port ?? '') || Number(port) < 1024 || Number(port) > 65535) throw new Error('Service ports must be integers from 1024 to 65535.');
  if (tracker.PORT === auth.AUTH_PORT) throw new Error('Tracker and auth must use distinct ports.');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(tracker.BASE_PATH ?? '')) throw new Error('Invalid BASE_PATH.');
  if (tracker.DATA_DIR !== '/var/lib/lidoll/tracker' || auth.AUTH_DATA_DIR !== '/var/lib/lidoll/auth') throw new Error('This installer requires persistent directories /var/lib/lidoll/tracker and /var/lib/lidoll/auth. Migrate existing data there before installing.');
  if (tracker.OIDC_ISSUER !== auth.AUTH_ISSUER || !tracker.OIDC_CLIENT_ID || auth.AUTH_TRUST_PROXY !== '1') throw new Error('The issuer/client settings must agree, and AUTH_TRUST_PROXY must be 1 behind the reverse proxy.');
  const callback = `${tracker.PUBLIC_ORIGIN}${tracker.BASE_PATH}auth/callback`;
  if (auth.TRACKER_REDIRECT_URI !== callback) throw new Error(`TRACKER_REDIRECT_URI must be ${callback}.`);
  return { tracker, auth };
}

export function firewallRules(proxyIp, ports) { // Opens only the supplied proxy source to the two application ports.
  if (!isIP(proxyIp)) throw new Error('A single proxy IP is required.');
  return ports.map(port => `rule family="ipv${isIP(proxyIp)}" source address="${proxyIp}" port port="${port}" protocol="tcp" accept`);
}

export function fetchBranch({ repository, branch, mirror, exists, git }) { // Fetches a named branch into a private mirror and returns the exact commit to deploy.
  if (!exists) {
    git(['init', '--bare', mirror]);
    git(['--git-dir', mirror, 'remote', 'add', 'origin', repository]);
  }
  if (git(['--git-dir', mirror, 'remote', 'get-url', 'origin']).trim() !== repository) throw new Error('The deployment mirror has a different GitHub origin. Check deploy.json before changing repositories.');
  git(['check-ref-format', '--branch', branch]);
  git(['--git-dir', mirror, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const commit = git(['--git-dir', mirror, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Git returned an invalid commit ID.');
  return commit;
}

export function serviceUnit({ name, user, script, dataDirectory }) { // Gives each service its own Unix identity, env file, and writable data directory.
  if (!['tracker', 'auth'].includes(name)) throw new Error('Unknown service.');
  return `[Unit]
Description=lidoll.dev ${name}
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=/opt/lidoll/current
ExecStart=/usr/bin/node-24 --env-file=/etc/lidoll/${name}.env ${script}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${dataDirectory}
InaccessiblePaths=/var/lib/lidoll/${name === 'auth' ? 'tracker' : 'auth'} /var/backups/lidoll /var/lib/lidoll-deploy
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;
}

export async function activateRelease(operations) { // Restores previous code on activation failure, but never overwrites potentially newer database writes with an old backup.
  let stopped = false, switched = false;
  try {
    stopped = true;
    await operations.stop();
    await operations.backup();
    await operations.switchToNew();
    switched = true;
    await operations.start();
    await operations.health();
  } catch (failure) {
    try {
      if (stopped) await operations.stop();
      if (switched) await operations.restorePrevious();
      if (operations.hasPrevious && stopped) {
        await operations.start();
        await operations.previousHealth();
      }
    } catch (rollbackFailure) {
      await operations.stop().catch(() => {});
      throw new AggregateError([failure, rollbackFailure], 'Release failed and the previous release did not recover. Services are stopped; preserve current data and inspect the saved backup.');
    }
    throw new Error(`${failure.message} ${operations.hasPrevious ? 'Previous code restored; persistent data was not reverted.' : 'First deployment stopped; generated data was retained.'}`, { cause: failure });
  }
}
