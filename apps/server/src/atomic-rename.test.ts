import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicRename } from './atomic-rename.js';

const windows = process.platform === 'win32';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'paso-rename-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Keeps the file open for reading, as a scan of the folder, an editor or an antivirus does, for `ms`. */
async function readerHolds(file: string, ms: number) {
  const handle = await open(file, 'r');
  return new Promise<void>((resolve) => { setTimeout(() => { void handle.close().then(resolve); }, ms); });
}

describe('atomicRename', () => {
  it('replaces a file that another process is reading, once the reader lets go', async () => {
    const file = join(root, 'workspaces.json');
    await writeFile(file, 'old\n');
    await writeFile(`${file}.tmp`, 'new\n');
    const released = readerHolds(file, 150);
    await atomicRename(`${file}.tmp`, file);
    await released;
    expect(await readFile(file, 'utf8')).toBe('new\n');
  });
  // Windows only: elsewhere a rename never waits for readers, so there is nothing to give up on.
  it.runIf(windows)('gives up and reports the error when the file stays held', async () => {
    const file = join(root, 'step.json');
    await writeFile(file, 'old\n');
    await writeFile(`${file}.tmp`, 'new\n');
    const released = readerHolds(file, 600);
    await expect(atomicRename(`${file}.tmp`, file, { waitMs: 100 })).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/) });
    await released;
    expect(await readFile(file, 'utf8')).toBe('old\n');
  });
  it('reports other errors at once, such as a missing source', async () => {
    const started = Date.now();
    await expect(atomicRename(join(root, 'missing'), join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
