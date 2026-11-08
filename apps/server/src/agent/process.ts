import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/**
 * Variables a harness process may inherit. Everything else is dropped, so a service started from
 * inside another agent (CLAUDECODE, CLAUDE_CODE_*, T3CODE_*) or from a shell holding API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY...) behaves like one started from a normal terminal and the
 * harness uses the user's own login. These cover finding the login (HOME, USER and LOGNAME are
 * needed by the macOS keychain lookup), locale, temp files, proxies and certificates.
 */
const inheritedNames = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERNAME', 'USERDOMAIN', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
] as const;

/** Builds a harness environment from the whitelist plus explicit additions. */
export function harnessEnvironment(additions: Record<string, string>, source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const name of inheritedNames) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) if (name.startsWith('LC_') && value !== undefined) env[name] = value;
  return { ...env, ...additions };
}

export type ProcessEnd = {
  /** `exit` is a normal end. The others are why Paso ended the process or why it never ran. */
  reason: 'exit' | 'aborted' | 'idle' | 'max-time' | 'line-too-long' | 'stopped' | 'spawn-error';
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last bytes of stderr. For classification only. It must never be logged or shown. */
  stderrTail: string;
  spawnErrorCode?: string;
};
export type ProcessSpec = {
  file: string; args: string[]; cwd: string; env: Record<string, string>;
  /** Initial stdin content. Stdin closes after the newline unless keepStdinOpen is set. */
  input: string;
  /** Keep stdin open for request/response protocols such as Codex app-server. */
  keepStdinOpen?: boolean;
};
export type ProcessOptions = {
  onLine(line: string): void;
  idleTimeoutMs: number; maxRunMs: number; maxLineBytes: number;
  signal: AbortSignal;
};
export type ManagedProcess = {
  write(line: string): void;
  /** Ends the process tree. Resolves when nothing of it is left. Safe to call more than once. */
  stop(): Promise<void>;
  done: Promise<ProcessEnd>;
};

const live = new Set<number>();
let exitHandlerInstalled = false;
/** Last resort if the service dies abnormally: no harness process group outlives it. */
function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => { for (const pid of live) signalGroup(pid, 'SIGKILL'); });
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    if (process.platform === 'win32') {
      if (signal !== 0) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    } else process.kill(-pid, signal);
    return true;
  } catch { return false; }
}
function groupAlive(pid: number) {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Terminates a whole process group: polite first, forceful after a short grace period. */
async function terminateTree(pid: number, graceMs = 1500) {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await delay(25);
  if (groupAlive(pid)) {
    signalGroup(pid, 'SIGKILL');
    const hard = Date.now() + 2000;
    while (groupAlive(pid) && Date.now() < hard) await delay(25);
  }
  live.delete(pid);
}

/**
 * Starts a harness process. Arguments are an array and never pass through a shell. The process
 * leads its own group (POSIX) so the harness and everything it started can be stopped together.
 */
export function startProcess(spec: ProcessSpec, options: ProcessOptions): ManagedProcess {
  installExitHandler();
  let child: ChildProcess;
  let wanted: ProcessEnd['reason'] | null = null;
  let stopping: Promise<void> | undefined;
  let settle!: (end: ProcessEnd) => void;
  const done = new Promise<ProcessEnd>((resolve) => { settle = resolve; });
  let stderrTail = '';
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    settle({ reason: 'spawn-error', code: null, signal: null, stderrTail: '', spawnErrorCode: (error as NodeJS.ErrnoException).code });
    return { write: () => {}, stop: async () => {}, done };
  }
  const pid = child.pid;
  if (pid !== undefined) live.add(pid);

  let idle: ReturnType<typeof setTimeout> | undefined;
  const hardTimer = setTimeout(() => void stop('max-time'), options.maxRunMs);
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => void stop('idle'), options.idleTimeoutMs); };
  function stop(reason: ProcessEnd['reason'] = 'stopped'): Promise<void> {
    wanted ??= reason;
    stopping ??= pid === undefined ? Promise.resolve() : terminateTree(pid);
    return stopping;
  }
  const onAbort = () => void stop('aborted');
  if (options.signal.aborted) onAbort(); else options.signal.addEventListener('abort', onAbort, { once: true });
  armIdle();

  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (line: string) => { if (line.trim()) options.onLine(line); };
  child.stdout!.on('data', (chunk: Buffer) => {
    if (wanted) return;
    armIdle();
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      emit(line);
    }
    if (pending.length > options.maxLineBytes) { pending = ''; void stop('line-too-long'); }
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096); });
  child.stdin!.on('error', () => {});
  child.stdout!.on('error', () => {});
  child.stderr!.on('error', () => {});
  if (spec.keepStdinOpen) { if (spec.input) child.stdin!.write(spec.input + '\n'); }
  else child.stdin!.end(spec.input + '\n');

  child.once('error', (error: NodeJS.ErrnoException) => {
    if (pid !== undefined) return; // A failure after start still ends through `close`.
    clearTimeout(hardTimer); clearTimeout(idle);
    options.signal.removeEventListener('abort', onAbort);
    settle({ reason: 'spawn-error', code: null, signal: null, stderrTail, spawnErrorCode: error.code });
  });
  child.once('close', (code, signal) => {
    clearTimeout(hardTimer); clearTimeout(idle);
    options.signal.removeEventListener('abort', onAbort);
    void (async () => {
      // A normal exit can leave helpers behind (such as the MCP server). Remove them too.
      if (pid !== undefined && groupAlive(pid)) await terminateTree(pid, 500);
      live.delete(pid ?? -1);
      if (!wanted && pending) emit(pending);
      pending = '';
      settle({ reason: wanted ?? 'exit', code, signal, stderrTail });
    })();
  });
  return { write: (line) => { if (!wanted && !child.stdin!.destroyed) child.stdin!.write(line + '\n'); }, stop: () => stop('stopped'), done };
}
