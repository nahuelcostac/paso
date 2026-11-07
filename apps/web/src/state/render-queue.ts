/**
 * Runs heavy tasks one at a time, so drawing thumbnails never blocks the page for long and a
 * scroll past many scenes does not draw them all. A task whose caller gave up is skipped, not run.
 */
export class RenderQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>, cancelled: () => boolean): Promise<T | undefined> {
    const result = this.tail.then(() => (cancelled() ? undefined : task()));
    this.tail = result.catch(() => undefined);
    return result;
  }
}
