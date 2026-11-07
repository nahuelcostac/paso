import { Folder, type LucideIcon } from 'lucide-react';
import { ICONS, type IconEntry } from './icon-catalog';
import { fold } from './format';

const byName = new Map(ICONS.map((entry) => [entry.name, entry]));

/** The icon for a stored name. A project with none, or one this build does not list, shows a folder. */
export function iconFor(name: string | undefined): LucideIcon {
  return (name ? byName.get(name)?.icon : undefined) ?? Folder;
}
export const DEFAULT_ICON = 'folder';

export function ProjectIcon({ name }: { name?: string }) {
  const Icon = iconFor(name);
  return <Icon className="i" aria-hidden="true" />;
}

/** Matches the Spanish name, the keywords and the Lucide name, ignoring case and accents. */
export function searchIcons(query: string): IconEntry[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return ICONS;
  return ICONS.filter((entry) => {
    const haystack = fold(`${entry.label} ${entry.words} ${entry.name}`);
    return terms.every((term) => haystack.includes(term));
  });
}
