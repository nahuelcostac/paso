import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Shared only with the two child processes. Never print the token or put it on disk.
const env = {
  ...process.env,
  PASO_SESSION_TOKEN: randomBytes(32).toString('base64url'),
  PASO_PORT: '3001',
  PASO_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
};
const child = spawn('pnpm', ['exec', 'concurrently', '-k', '-n', 'server,web',
  'pnpm --filter @paso/server dev', 'pnpm --filter @paso/web dev'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => { process.exitCode = code ?? 1; });
