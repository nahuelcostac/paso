import { rename } from 'node:fs/promises';

/** Errors Windows gives while another process has the file, or a file in the folder, open. */
const busy = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Renames in one step, replacing a file that is already there: how every write here becomes atomic.
 *
 * On Windows the rename fails with EPERM, EACCES or EBUSY while any other process has the target open, even only to
 * read it: the service's own scan of the folder, an editor, the search indexer or an antivirus. Those holds last
 * milliseconds, so the rename is tried again for up to `waitMs` before the error is reported. Other platforms never
 * refuse a rename for an open file, so their errors are reported at once.
 */
export async function atomicRename(from: string, to: string, { waitMs = 2000, platform = process.platform } = {}) {
  const started = Date.now();
  for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !busy.has(code) || Date.now() - started >= waitMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
