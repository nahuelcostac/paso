import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

/**
 * How to start pnpm without a shell. A script that pnpm runs gets pnpm's own entry in `npm_execpath`, and this Node
 * runs it directly. That matters on Windows, where `pnpm` on the PATH is a .cmd file that Node cannot start without
 * a shell, and a shell would read the arguments as commands.
 */
export function pnpmCommand(args, { env = process.env, platform = process.platform, node = process.execPath } = {}) {
  const entry = env.npm_execpath;
  if (entry && /^pnpm(\.c?js|\.exe)?$/i.test(win32.basename(entry))) {
    return /\.exe$/i.test(entry) ? { file: entry, args } : { file: node, args: [entry, ...args] };
  }
  if (platform === 'win32') throw new Error('Start this through pnpm, for example `pnpm dev`.');
  return { file: 'pnpm', args };
}

export function spawnPnpm(args, options = {}) {
  const { file, args: argv } = pnpmCommand(args);
  return spawn(file, argv, { ...options, shell: false });
}
