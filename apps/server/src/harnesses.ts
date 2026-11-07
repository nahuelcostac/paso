import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiError, isMissing } from './errors.js';

const ids = ['claude', 'codex', 'agy'] as const;
type HarnessId = typeof ids[number];
type Status = 'signed_in' | 'signed_out' | 'unknown';
export type DetectionOptions = { searchPaths?: string[]; loginShell?: boolean; timeoutMs?: number };
function validId(value: unknown): value is HarnessId { return typeof value === 'string' && ids.some((id) => id === value); }
function run(file: string, args: string[], timeout: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => execFile(file, args, { timeout, maxBuffer: 64 * 1024, windowsHide: true, env: process.env }, (error, stdout, stderr) => {
    done({ ok: !error, output: String(stdout) + (args[0] === 'login' ? String(stderr) : '') });
  }));
}
async function executable(path: string) {
  try { await access(path, constants.X_OK); return await realpath(path); } catch { return null; }
}
async function find(id: HarnessId, options: DetectionOptions) {
  const paths = options.searchPaths ?? [
    ...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
  for (const dir of paths) {
    if (!dir || !isAbsolute(dir)) continue;
    const result = await executable(join(dir, id));
    if (result) return result;
  }
  if (options.loginShell !== false && process.platform !== 'win32') {
    const shell = process.env.SHELL;
    if (shell && isAbsolute(shell)) {
      // The only interpolated value is a fixed member of ids, never request data.
      const result = await run(shell, ['-ilc', `command -v ${id}`], options.timeoutMs ?? 3000);
      const path = result.output.trim().split('\n').at(-1) ?? '';
      if (result.ok && isAbsolute(path)) return executable(path);
    }
  }
  return null;
}
export async function detectHarness(id: HarnessId, options: DetectionOptions = {}) {
  const path = await find(id, options);
  if (!path) return { id, found: false, path: null, version: null, session: 'unknown' as Status, message: 'Instala este asistente y vuelve a buscarlo.' };
  const timeout = options.timeoutMs ?? 3000;
  const [versionResult, auth] = await Promise.all([
    run(path, ['--version'], timeout),
    id === 'claude' ? run(path, ['auth', 'status', '--json'], timeout) :
      id === 'codex' ? run(path, ['login', 'status'], timeout) : Promise.resolve(null),
  ]);
  const match = versionResult.ok ? versionResult.output.trim().match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/) : null;
  let session: Status = 'unknown';
  if (id === 'claude' && auth) {
    try { const data = JSON.parse(auth.output) as { loggedIn?: unknown }; if (typeof data.loggedIn === 'boolean') session = data.loggedIn ? 'signed_in' : 'signed_out'; } catch { /* Unknown output. */ }
  } else if (id === 'codex' && auth) {
    // Codex reports status on stdout or stderr depending on version. Exit status is
    // insufficient to distinguish a failure from a signed-out account.
    if (/not logged in/i.test(auth.output)) session = 'signed_out';
    else if (auth.ok && /logged in/i.test(auth.output)) session = 'signed_in';
  }
  return { id, found: true, path, version: match?.[0] ?? null, session,
    ...(session === 'signed_out' ? { message: 'Inicia sesión en este asistente y vuelve a buscarlo.' } : {}) };
}
export class HarnessRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private options: DetectionOptions) {}
  async detect() { return { harnesses: await Promise.all(ids.map((id) => detectHarness(id, this.options))) }; }
  private async read(): Promise<HarnessId[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(value) || !value.every(validId) || new Set(value).size !== value.length) throw new Error('Invalid harness registry');
      return value;
    } catch (error) { if (isMissing(error)) return []; throw error; }
  }
  async list() { const selected = await this.read(); return { harnesses: await Promise.all(selected.map((id) => detectHarness(id, this.options))) }; }
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation); this.queue = next; return next;
  }
  private async write(idsToWrite: HarnessId[]) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = join(dirname(this.file), `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(idsToWrite) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async add(value: unknown) {
    if (!validId(value)) throw new ApiError(400, 'INVALID_HARNESS', 'Asistente desconocido.');
    const detected = await detectHarness(value, this.options);
    if (!detected.found) throw new ApiError(422, 'HARNESS_NOT_FOUND', 'No se ha encontrado el asistente. Instálalo y vuelve a intentarlo.');
    return this.change(async () => { const current = await this.read(); if (!current.includes(value)) await this.write([...current, value]); return detected; });
  }
  async remove(value: unknown) {
    if (!validId(value)) throw new ApiError(400, 'INVALID_HARNESS', 'Asistente desconocido.');
    return this.change(async () => { const current = await this.read(); await this.write(current.filter((id) => id !== value)); });
  }
}
export function registryPath(dataDir: string, configured?: string) {
  const root = resolve(dataDir); const file = resolve(configured ?? join(dirname(root), 'harnesses.json'));
  if (file === root || file.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Harness registry must be outside dataDir.');
  return file;
}
