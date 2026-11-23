import { isLooseProject } from '@paso/shared';
import type { ProjectRow, StoreState } from '../state/projects-store';
import { fold } from './format';

/**
 * The sidebar's project filter, as in T3 Code: null shows everything, a project's ID shows only that project and its
 * scenes, and `LOOSE_PROJECT_ID` shows only the loose diagrams. Each workspace remembers its own, on the service.
 */
export type ProjectFilter = string | null;

/**
 * The filter in effect. A project that is no longer in the workspace reads as “All projects”; while the list is still
 * loading the filter is taken as it is, since its project may be on the way.
 */
export function shownFilter(filter: ProjectFilter | undefined, rows: ProjectRow[], phase: StoreState['phase']): ProjectFilter {
  if (!filter) return null;
  if (isLooseProject(filter) || phase !== 'ready') return filter;
  return rows.some((row) => row.id === filter) ? filter : null;
}

/** Whether a project, or the loose diagrams (`LOOSE_PROJECT_ID`), shows under the filter. */
export const showsUnder = (filter: ProjectFilter, projectId: string) => filter === null || filter === projectId;

/**
 * The choices that match a search, by every word of it, ignoring case and accents. While searching, “All projects”
 * is not offered, as in T3 Code: the search is for a project.
 */
export function matchChoices<T extends { value: ProjectFilter; label: string }>(choices: T[], query: string): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return choices;
  return choices.filter((choice) => choice.value !== null && terms.every((term) => fold(choice.label).includes(term)));
}
