export type QueueJob<Page> = { key: string; run: () => Promise<Page> };
export type QueueResult<Page> = { page: Page; failed?: undefined } | { page?: undefined; failed: true };

/**
 * Prepares pages one at a time, most urgent first. A new list replaces the old one, so holding down a key in a long
 * scene renders where the person is now, not every step they passed on the way. Finished pages are kept up to `limit`.
 * It can be disposed and used again, because React's StrictMode runs effects twice.
 */
export class PageQueue<Page> {
  private results = new Map<string, QueueResult<Page>>();
  private pending: Array<QueueJob<Page>> = [];
  private running = false;
  private generation = 0;
  constructor(private onChange: () => void, private release: (page: Page) => void, private limit = 12) {}

  peek = (key: string) => this.results.get(key);
  /** Forgets a failure, so that a new view of the step tries again. */
  retry(key: string) { if (this.results.get(key)?.failed) this.results.delete(key); }
  /** `keep` lists pages that must survive besides the jobs, such as the one on screen. */
  want(jobs: Array<QueueJob<Page>>, keep: string[] = []) {
    this.pending = jobs.filter((job) => !this.results.has(job.key));
    const kept = new Set([...keep, ...jobs.map((job) => job.key)]);
    for (const key of [...this.results.keys()]) {
      if (this.results.size <= this.limit) break;
      if (kept.has(key)) continue;
      const result = this.results.get(key)!;
      this.results.delete(key);
      if (result.page !== undefined) this.release(result.page);
    }
    void this.pump();
  }
  dispose() {
    this.generation++; this.pending = []; this.running = false;
    for (const result of this.results.values()) if (result.page !== undefined) this.release(result.page);
    this.results.clear();
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    while (generation === this.generation) {
      const job = this.pending.shift();
      if (!job) break;
      // Asked for again while it was running, and finished since.
      if (this.results.has(job.key)) continue;
      let result: QueueResult<Page>;
      try { result = { page: await job.run() }; } catch { result = { failed: true }; }
      // Disposed while it was running: nobody will show this page.
      if (generation !== this.generation) { if (result.page !== undefined) this.release(result.page); return; }
      this.results.set(job.key, result);
      this.onChange();
    }
    if (generation === this.generation) this.running = false;
  }
}
