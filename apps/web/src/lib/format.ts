const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 scenes · 17 steps". A project with no scenes says so instead of showing two zeros. */
export function formatSize(scenes: number, steps: number) {
  if (scenes === 0) return 'No scenes';
  return `${plural(scenes, 'scene', 'scenes')} · ${plural(steps, 'step', 'steps')}`;
}

/** "4 scenes and 17 steps", for sentences. */
export const describeContents = (scenes: number, steps: number) => `${plural(scenes, 'scene', 'scenes')} and ${plural(steps, 'step', 'steps')}`;

/** Lower case without accents, so "cafe" finds "Café". */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The service's own message for a project it cannot open, in terms a person can act on. */
export function explainProjectError(message: string) {
  if (/newer than supported version/i.test(message)) {
    return { short: 'Made with a newer version of Paso', long: 'This project was made with a newer version of Paso. Update Paso to open it.' };
  }
  return { short: "Can't be read: damaged files", long: "This project's files aren't valid. Repair them on disk or restore a copy; your other projects keep working." };
}

/** "4 steps" for a scene's heading. An empty scene says so. */
export const formatSteps = (count: number) => count === 0 ? 'No steps' : plural(count, 'step', 'steps');

export type RecencyGroup<T> = { label: 'Today' | 'This month' | 'Earlier'; items: T[] };

/**
 * The sidebar's groups, by when each project last changed: today, earlier this month, and before. Dates are compared on
 * the person's own calendar. A date in the future, from another computer's clock, counts as today. Empty groups are left out.
 */
export function groupByRecency<T>(items: T[], changedAt: (item: T) => string, now = new Date()): RecencyGroup<T>[] {
  const groups: RecencyGroup<T>[] = [{ label: 'Today', items: [] }, { label: 'This month', items: [] }, { label: 'Earlier', items: [] }];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  for (const item of items) {
    const at = new Date(changedAt(item)).getTime();
    groups[Number.isNaN(at) ? 2 : at >= today ? 0 : at >= month ? 1 : 2].items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}
