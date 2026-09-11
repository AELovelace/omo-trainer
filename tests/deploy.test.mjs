import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { activateRelease, validateConfig, validateEnvironment, firewallRules, serviceUnit, DEFAULTS, fetchBranch } from '../deploy/release.mjs';
import { run } from '../deploy/command.mjs';

const tracker = readFileSync(new URL('../deploy/tracker.env.example', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../deploy/auth.env.example', import.meta.url), 'utf8');

test('deployment commands leave the invoking checkout and retain explicit staging directories', () => {
  mkdirSync('artifacts', { recursive: true });
  const stage = mkdtempSync(resolve('artifacts/deploy-cwd-'));
  const original = process.cwd();
  try {
    process.chdir(stage); // Simulates starting the installer inside an operator-owned checkout.
    const probe = ['--eval', 'process.stdout.write(process.cwd())'];
    assert.equal(realpathSync(run(process.execPath, probe, { capture: true })), realpathSync('/'));
    assert.equal(realpathSync(run(process.execPath, probe, { cwd: stage, capture: true })), realpathSync(stage));
    assert.equal(process.cwd(), stage, 'Only child commands should change working directory');
  } finally { process.chdir(original); }
});

function scenario(failAt, hasPrevious = true) { // Simulates deployment side effects so rollback behavior can be tested without touching host services or real databases.
  const calls = [];
  const operation = name => async () => { calls.push(name); if (name === failAt) throw new Error(`Failed at ${name}`); };
  return { calls, operations: { hasPrevious, stop: operation('stop'), backup: operation('backup'), switchToNew: operation('switch'), start: operation('start'), health: operation('health'), restorePrevious: operation('restore'), previousHealth: operation('previousHealth') } };
}

test('deployment stops writers before backup and starts only after the new code is selected', async () => {
  const { calls, operations } = scenario();
  await activateRelease(operations);
  assert.deepEqual(calls, ['stop', 'backup', 'switch', 'start', 'health']);
});

test('a failed health check rolls back code and verifies the old release without restoring an old database', async () => {
  const { calls, operations } = scenario('health');
  await assert.rejects(() => activateRelease(operations), /persistent data was not reverted/);
  assert.deepEqual(calls, ['stop', 'backup', 'switch', 'start', 'health', 'stop', 'restore', 'start', 'previousHealth']);
});

test('a failed backup prevents activation and restarts the previous code', async () => {
  const { calls, operations } = scenario('backup');
  await assert.rejects(() => activateRelease(operations), /Failed at backup/);
  assert.deepEqual(calls, ['stop', 'backup', 'stop', 'start', 'previousHealth']);
});

test('first-deployment failure stops the candidate and removes its active link without deleting its new data', async () => {
  const { calls, operations } = scenario('health', false);
  await assert.rejects(() => activateRelease(operations), /generated data was retained/);
  assert.deepEqual(calls, ['stop', 'backup', 'switch', 'start', 'health', 'stop', 'restore']);
});

test('failed rollback leaves services stopped and exposes both errors for recovery', async () => {
  const { calls, operations } = scenario('health');
  operations.previousHealth = async () => { throw new Error('Old schema no longer compatible'); };
  await assert.rejects(() => activateRelease(operations), error => error instanceof AggregateError && error.errors.length === 2 && /Services are stopped/.test(error.message));
  assert.equal(calls.at(-1), 'stop');
});

test('GitHub configuration accepts the project and rejects credential-bearing URLs and unsafe branch values', () => {
  assert.equal(validateConfig(DEFAULTS).repo, 'https://github.com/AELovelace/omo-trainer.git');
  assert.equal(validateConfig({ repo: 'git@github.com:AELovelace/omo-trainer.git', branch: 'release/stable' }).branch, 'release/stable');
  for (const repo of ['https://token@github.com/a/b', 'file:///tmp/repo', 'https://evil.example/repo', 'https://github.com/a/b\nmalicious']) assert.throws(() => validateConfig({ repo }));
  for (const branch of ['--upload-pack=bad', 'main\necho bad', '../main', 'main.lock']) assert.throws(() => validateConfig({ branch }));
  assert.throws(() => validateConfig({ publicOrigin: 'http://lidoll.dev' }));
  assert.throws(() => validateConfig({ authOrigin: 'https://auth.lidoll.dev/wrong-path' }));
});

test('existing env files must keep data in backed-up directories and use matching identity callbacks', () => {
  assert.equal(validateEnvironment(tracker, auth).tracker.PORT, '4173');
  assert.throws(() => validateEnvironment(tracker.replace('/var/lib/lidoll/tracker', '/opt/lidoll/current/data'), auth), /persistent directories/);
  assert.throws(() => validateEnvironment(tracker, auth.replace('AUTH_PORT=4180', 'AUTH_PORT=4173')), /distinct ports/);
  assert.throws(() => validateEnvironment(tracker, auth.replace('/tracker/auth/callback', '/other/callback')), /TRACKER_REDIRECT_URI/);
  assert.throws(() => validateEnvironment(tracker.replace('NODE_ENV=production', 'NODE_ENV=test'), auth), /production/);
});

test('firewall access is restricted to a single proxy address for IPv4 and IPv6', () => {
  const rules = firewallRules('10.1.1.10', ['4173', '4180']);
  assert.equal(rules[0], 'rule family="ipv4" source address="10.1.1.10" port port="4173" protocol="tcp" accept');
  assert.match(firewallRules('2001:db8::5', ['4180'])[0], /family="ipv6"/);
  assert.throws(() => firewallRules('0.0.0.0/0', ['4173']));
});

test('service users have isolated writable state and stable versioned Node execution', () => {
  const unit = serviceUnit({ name: 'auth', user: 'lidoll-auth', script: 'scripts/auth-server.mjs', dataDirectory: '/var/lib/lidoll/auth' });
  assert.match(unit, /User=lidoll-auth/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node-24 --env-file=\/etc\/lidoll\/auth.env/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/lidoll\/auth/);
  assert.match(unit, /InaccessiblePaths=\/var\/lib\/lidoll\/tracker/);
  assert.match(unit, /ProtectSystem=strict/);
});

test('real Git fetch and detached staging deploy new commits without modifying the previous release', () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(resolve('artifacts/deploy-git-'));
  const repository = join(directory, 'source'), mirror = join(directory, 'mirror.git');
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--initial-branch=main', repository]);
  const makeCommit = text => {
    writeFileSync(join(repository, 'release.txt'), text);
    git(['add', 'release.txt'], repository);
    git(['-c', 'user.name=Deploy test', '-c', 'user.email=deploy-test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', text], repository);
  };
  const fetch = () => fetchBranch({ repository, branch: 'main', mirror, exists: existsSync(mirror), git });
  const checkout = (name, commit) => {
    const target = join(directory, name);
    git(['clone', '--no-hardlinks', '--no-checkout', mirror, target]);
    git(['checkout', '--detach', commit], target);
    return target;
  };
  makeCommit('first release');
  const first = fetch();
  const oldRelease = checkout('old', first);
  makeCommit('second release');
  const second = fetch();
  assert.notEqual(second, first);
  assert.equal(fetch(), second, 'An unchanged remote must resolve to the same commit');
  const newRelease = checkout('new', second);
  assert.equal(readFileSync(join(oldRelease, 'release.txt'), 'utf8'), 'first release');
  assert.equal(readFileSync(join(newRelease, 'release.txt'), 'utf8'), 'second release');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], newRelease), 'HEAD', 'The staged revision is detached from the moving branch');
  assert.throws(() => fetchBranch({ repository: join(directory, 'other'), branch: 'main', mirror, exists: true, git }), /different GitHub origin/);
});
