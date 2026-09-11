import { execFileSync } from 'node:child_process';

export function run(program, arguments_, { user, cwd = '/', capture = false } = {}) { // Runs commands from an accessible directory instead of inheriting a private bootstrap checkout.
  const executable = user ? '/usr/sbin/runuser' : program;
  const parameters = user ? ['-u', user, '--', program, ...arguments_] : arguments_;
  // Set cwd before runuser drops privileges; callers still select the staged checkout for npm and tests.
  return execFileSync(executable, parameters, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
  })?.trim();
}
