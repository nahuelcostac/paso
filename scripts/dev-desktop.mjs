import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(import.meta.dirname, '..');
let child;
let build;
let stopping = false;
let rebuilding = false;
let pending = false;
let timer;
let snapshot;
const source = resolve(root, 'apps/server/src');
async function scan(directory = source) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? scan(path) : `${path}:${(await stat(path)).mtimeMs}`;
  }));
  return files.flat(Infinity).sort().join('\n');
}
const watcher = { close() { clearInterval(timer); } };

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const current = spawn(command, args, { cwd: root, stdio: 'inherit' });
    build = current;
    current.once('error', reject);
    current.once('exit', (code) => {
      if (build === current) build = undefined;
      if (code === 0 || stopping) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
function stopElectron() {
  if (!child) return Promise.resolve();
  const current = child;
  return new Promise((resolvePromise) => {
    current.once('exit', resolvePromise);
    current.kill('SIGTERM');
  });
}
function launch() {
  const env = { ...process.env, PASO_DEV_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [resolve(root, 'apps/desktop/dev-main.mjs')], { cwd: root, stdio: 'inherit', env });
  const current = child;
  current.once('exit', (code) => {
    if (child === current) child = undefined;
    if (!rebuilding && !stopping) { stopping = true; watcher.close(); process.exitCode = code ?? 1; }
  });
  current.once('error', (error) => { console.error(error); stopping = true; watcher.close(); process.exitCode = 1; });
}
async function rebuild() {
  if (stopping) return;
  if (rebuilding) { pending = true; return; }
  rebuilding = true;
  try {
    await stopElectron();
    await run('pnpm', ['--filter', '@paso/server', 'build']);
    if (!stopping && !pending) launch();
  } catch (error) { console.error(error); }
  finally {
    rebuilding = false;
    if (pending && !stopping) { pending = false; void rebuild(); }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true; watcher.close(); build?.kill('SIGTERM'); void stopElectron();
});
try {
  await run('pnpm', ['--filter', '@paso/mcp...', 'build']);
  if (!stopping) {
    snapshot = await scan();
    timer = setInterval(() => {
      void scan().then((next) => { if (next !== snapshot) { snapshot = next; void rebuild(); } }).catch((error) => console.error(error));
    }, 1000);
    launch();
  }
} catch (error) { console.error(error); watcher.close(); process.exitCode = 1; }
