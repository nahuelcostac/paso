import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { linkCodexLogin } from './agent/codex-policy.js';
import { harnessEnvironment, startProcess } from './agent/process.js';

export type CodexModel = { id: string; label: string; isDefault: boolean; efforts: string[] };
export const fallbackModels: CodexModel[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: false, efforts: [] },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', isDefault: false, efforts: [] },
];
const allowed = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function parseModels(value: unknown): CodexModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.model !== 'string' || !item.model || typeof item.displayName !== 'string') return [];
    const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.flatMap((level: unknown) => {
      if (!level || typeof level !== 'object') return [];
      const effort = (level as Record<string, unknown>).reasoningEffort;
      return typeof effort === 'string' && allowed.has(effort) ? [effort] : [];
    }) : [];
    return [{ id: item.model, label: item.displayName, isDefault: item.isDefault === true, efforts }];
  });
}

/** An isolated app-server gets only the login link and receives no thread or tool calls. */
export async function discoverCodexModels(executable: string, timeoutMs = 4000): Promise<CodexModel[]> {
  const dir = await mkdtemp(join(tmpdir(), 'paso-models-'));
  try {
    await linkCodexLogin(join(resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')), 'auth.json'), join(dir, 'auth.json'));
    let models: CodexModel[] = [];
    const proc = startProcess({
      file: executable, args: ['app-server', '--listen', 'stdio://'], cwd: dir, env: harnessEnvironment({ CODEX_HOME: dir }),
      input: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'paso', version: '1.0.0' } } }),
      keepStdinOpen: true,
    }, {
      signal: new AbortController().signal, idleTimeoutMs: timeoutMs, maxRunMs: timeoutMs, maxLineBytes: 1024 * 1024,
      onLine(line) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { data?: unknown; nextCursor?: string | null } };
          if (message.id === 1) {
            proc.write(JSON.stringify({ method: 'initialized' }));
            proc.write(JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100 } }));
          } else if (message.id === 2) {
            models = message.result?.nextCursor ? [] : parseModels(message.result?.data);
            void proc.stop();
          }
        } catch { /* Ignore non-protocol output. */ }
      },
    });
    await proc.done;
    return models.length ? models : fallbackModels;
  } catch { return fallbackModels; } finally { await rm(dir, { recursive: true, force: true }); }
}
