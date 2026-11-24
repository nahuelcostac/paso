/**
 * Waits for a read and then for every newer read of the same thing that started meanwhile, and gives the read's own
 * answer.
 *
 * Where reads overlap and only the newest answer is applied, a caller that awaits its own read could otherwise go on
 * before anything was applied: its answer was dropped because a newer read was on its way, and that one had not
 * answered yet. Waiting for the newest means the state already shows a change the caller has just made. A newer read
 * that fails ends the wait; its owner handles the failure.
 */
export async function untilNewest<T>(read: Promise<T>, newest: () => Promise<T> | undefined): Promise<T> {
  const value = await read;
  for (let next = newest(), waited = read; next && next !== waited; next = newest()) {
    waited = next;
    try { await waited; } catch { break; }
  }
  return value;
}
