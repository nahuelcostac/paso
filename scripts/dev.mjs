import { randomBytes } from 'node:crypto';
import { spawnPnpm } from './pnpm.mjs';

// Shared only with the two child processes. Never print the token or put it on disk.
const env = {
  ...process.env,
  PASO_SESSION_TOKEN: randomBytes(32).toString('base64url'),
  PASO_PORT: '3001',
  PASO_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
};
const child = spawnPnpm(['exec', 'concurrently', '-k', '-n', 'server,web',
  'pnpm --filter @paso/server dev', 'pnpm --filter @paso/web dev'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
