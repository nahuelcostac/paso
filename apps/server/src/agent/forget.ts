import { readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Deleting a conversation also deletes the copy each harness keeps of it. These helpers find that copy from the resume
 * token only, and only inside the harness's folder for Paso's agent workspace: a token is never used as a path.
 */

/** Resume tokens are IDs: letters, digits and hyphens. Anything else is not looked for at all. */
const safeToken = /^[A-Za-z0-9-]{8,200}$/;

/** How Claude Code names a working directory's folder under `projects`: every character that is not a letter or digit becomes `-`. */
export const claudeProjectFolder = (workDir: string) => workDir.replace(/[^A-Za-z0-9]/g, '-');

/** Claude Code's transcript of one session and the folder beside it with that session's extra files. */
export async function claudeTranscriptPaths(token: string, workDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (!safeToken.test(token)) return [];
  const config = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  // Claude Code names the folder after the real path it runs in, so /tmp and /private/tmp are the same place.
  const real = await realpath(workDir).catch(() => resolve(workDir));
  const folder = join(config, 'projects', claudeProjectFolder(real));
  return [join(folder, `${token}.jsonl`), join(folder, token)];
}

export async function forgetClaude(token: string, workDir: string, env: NodeJS.ProcessEnv = process.env) {
  for (const path of await claudeTranscriptPaths(token, workDir, env)) await rm(path, { recursive: true, force: true });
}

/** Codex keeps a rollout per thread under its home, in dated folders. Paso's Codex home sits next to the workspace. */
export async function codexTranscriptPaths(token: string, workDir: string) {
  if (!safeToken.test(token)) return [];
  const home = join(dirname(resolve(workDir)), 'codex-home');
  const found: string[] = [];
  const walk = async (folder: string, depth: number) => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 4) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && basename(entry.name, '.jsonl').endsWith(token)) found.push(path);
    }
  };
  for (const root of ['sessions', 'archived_sessions']) await walk(join(home, root), 0);
  return found;
}

export async function forgetCodex(token: string, workDir: string) {
  for (const path of await codexTranscriptPaths(token, workDir)) await rm(path, { force: true });
}
