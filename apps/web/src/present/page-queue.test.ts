import { describe, expect, it, vi } from 'vitest';
import { PageQueue, type QueueJob } from './page-queue';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
/** A job that finishes when told to. */
function jobs() {
  const started: string[] = []; const finish = new Map<string, (ok?: boolean) => void>();
  const job = (key: string): QueueJob<string> => ({ key, run: () => new Promise<string>((resolve, reject) => {
    started.push(key);
    finish.set(key, (ok = true) => { if (ok) resolve(key); else reject(new Error('no')); });
  }) });
  return { job, started, finish };
}

describe('preparing pages', () => {
  it('runs one at a time, in order', async () => {
    const { job, started, finish } = jobs();
    const changed = vi.fn();
    const queue = new PageQueue<string>(changed, () => {});
    queue.want([job('a'), job('b')]);
    expect(started).toEqual(['a']);
    finish.get('a')!(); await flush();
    expect(queue.peek('a')?.page).toBe('a'); expect(changed).toHaveBeenCalledTimes(1); expect(started).toEqual(['a', 'b']);
  });
  it('skips what is no longer wanted: only where the person is now gets drawn', async () => {
    const { job, started, finish } = jobs();
    const queue = new PageQueue<string>(() => {}, () => {});
    queue.want([job('1'), job('2'), job('3')]);
    queue.want([job('50'), job('51')]);   // a long scene, key held down
    finish.get('1')!(); await flush();
    expect(started).toEqual(['1', '50']);
  });
  it('does not draw twice a page asked for while it runs', async () => {
    const { job, started, finish } = jobs();
    const queue = new PageQueue<string>(() => {}, () => {});
    queue.want([job('a')]); queue.want([job('a'), job('b')]);
    finish.get('a')!(); await flush();
    expect(started).toEqual(['a', 'b']);
  });
  it('records a failure and tries again only when told to', async () => {
    const { job, started, finish } = jobs();
    const queue = new PageQueue<string>(() => {}, () => {});
    queue.want([job('a')]);
    finish.get('a')!(false); await flush();
    expect(queue.peek('a')?.failed).toBe(true);
    queue.want([job('a')]); expect(started).toEqual(['a']);
    queue.retry('a'); queue.want([job('a')]); expect(started).toEqual(['a', 'a']);
    finish.get('a')!(); await flush();
    expect(queue.peek('a')?.page).toBe('a');
  });
  it('lets go of the oldest pages beyond its limit, but never one in use', async () => {
    const { job, finish } = jobs();
    const released: string[] = [];
    const queue = new PageQueue<string>(() => {}, (page) => released.push(page), 2);
    for (const key of ['a', 'b', 'c']) { queue.want([job(key)], ['a']); finish.get(key)!(); await flush(); }
    queue.want([job('c')], ['a']);
    expect(released).toEqual(['b']);
    expect(queue.peek('a')?.page).toBe('a'); expect(queue.peek('b')).toBeUndefined();
  });
  it('releases everything when disposed, including a page that finishes later, and can be used again', async () => {
    const { job, finish } = jobs();
    const released: string[] = [];
    const queue = new PageQueue<string>(() => {}, (page) => released.push(page));
    queue.want([job('a')]); finish.get('a')!(); await flush();
    queue.want([job('b')]);
    queue.dispose();
    expect(released).toEqual(['a']); expect(queue.peek('a')).toBeUndefined();
    finish.get('b')!(); await flush();
    expect(released).toEqual(['a', 'b']); expect(queue.peek('b')).toBeUndefined();
    queue.want([job('c')]); finish.get('c')!(); await flush();
    expect(queue.peek('c')?.page).toBe('c');
  });
});
