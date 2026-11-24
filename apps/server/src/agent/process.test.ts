import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { startProcess } from './process.js';

/** Runs a Node script as a harness and collects the lines it prints. */
function lines(script: string, maxLineBytes = 64 * 1024 * 1024) {
  const seen: string[] = [];
  const child = startProcess(
    { file: process.execPath, args: ['-e', script], cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, input: '' },
    { onLine: (line) => seen.push(line), idleTimeoutMs: 10_000, maxRunMs: 20_000, maxLineBytes, signal: new AbortController().signal },
  );
  return { seen, done: child.done };
}

describe('harness output lines', () => {
  it('puts back together a line of many megabytes written in pieces, characters split across them included', async () => {
    // 24 MB of a three-byte character, written in odd sizes so pieces end inside a character, then two short lines.
    const { seen, done } = lines(`
      const big = Buffer.from('€'.repeat(8 * 1024 * 1024) + '\\n');
      let at = 0;
      const next = () => {
        if (at >= big.length) { process.stdout.write('short\\n\\nlast without newline'); return; }
        const end = Math.min(big.length, at + 65_537);
        process.stdout.write(big.subarray(at, end), next);
        at = end;
      };
      next();`);
    expect((await done).reason).toBe('exit');
    expect(seen).toHaveLength(3);
    expect(seen[0].length).toBe(8 * 1024 * 1024);
    expect(/^€+$/.test(seen[0])).toBe(true);
    expect(seen.slice(1)).toEqual(['short', 'last without newline']);
  });

  it('stops a harness whose line grows past the limit', async () => {
    const { seen, done } = lines(`process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000);`, 1000);
    expect((await done).reason).toBe('line-too-long');
    expect(seen).toEqual([]);
  });
});
