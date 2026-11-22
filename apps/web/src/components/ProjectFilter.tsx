import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LOOSE_PROJECT_ID } from '@paso/shared';
import { Check, ChevronDown, Folders, ListFilter, Search, Shapes } from 'lucide-react';
import { ProjectIcon } from '../lib/icons';
import { matchChoices, type ProjectFilter as Filter } from '../lib/project-filter';
import { Popover } from './Popover';

type Choice = { value: Filter; label: string; icon: ReactNode };

type Props = {
  /** The workspace's projects that can be opened, in the sidebar's order. */
  projects: Array<{ id: string; name: string; icon?: string }>;
  value: Filter;
  disabled?: boolean;
  onChange: (value: Filter) => void;
};

/**
 * The sidebar's project filter, after T3 Code's: a row naming what the list shows, “All projects”, one project or
 * “Loose diagrams”, that opens a searchable list of those choices. As in T3 Code the focus stays in the search field
 * while the arrow keys move through the list, Enter chooses, and Escape closes it.
 */
export function ProjectFilter({ projects, value, disabled = false, onChange }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const choices = useMemo<Choice[]>(() => [
    { value: null, label: 'All projects', icon: <Folders className="i" aria-hidden="true" /> },
    ...projects.map((project) => ({ value: project.id, label: project.name, icon: <ProjectIcon name={project.icon} /> })),
    { value: LOOSE_PROJECT_ID, label: 'Loose diagrams', icon: <Shapes className="i" aria-hidden="true" /> },
  ], [projects]);
  const chosen = choices.find((choice) => choice.value === value) ?? choices[0];
  return (
    <>
      <button
        ref={trigger} type="button" className="nav-row project-filter" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Filter by project: ${chosen.label}`} title={chosen.label} disabled={disabled} onClick={() => setOpen(!open)}
      >
        {value === null ? <ListFilter className="i" aria-hidden="true" /> : chosen.icon}
        <span className="project-filter__label">{chosen.label}</span>
        <ChevronDown className="i project-filter__chevron" aria-hidden="true" />
      </button>
      {open && trigger.current && (
        <FilterList
          anchor={trigger.current} choices={choices} value={chosen.value}
          onClose={() => setOpen(false)}
          onPick={(next) => { setOpen(false); trigger.current?.focus(); if (next !== value) onChange(next); }}
        />
      )}
    </>
  );
}

function FilterList({ anchor, choices, value, onClose, onPick }: { anchor: HTMLElement; choices: Choice[]; value: Filter; onClose: () => void; onPick: (value: Filter) => void }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const matches = useMemo(() => matchChoices(choices, query), [choices, query]);
  // The highlighted choice: on open the chosen one, and the first match once the search changes.
  const [active, setActive] = useState(() => Math.max(0, choices.findIndex((choice) => choice.value === value)));
  const list = useRef<HTMLDivElement>(null);
  const optionId = (index: number) => `${id}-option-${index}`;
  const highlight = (index: number) => {
    setActive(index);
    list.current?.querySelector(`#${CSS.escape(optionId(index))}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = matches.length - 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (last < 0) return;
      highlight(event.key === 'ArrowDown' ? (active >= last ? 0 : active + 1) : (active <= 0 ? last : active - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = matches[active];
      if (choice) onPick(choice.value);
    } else if (event.key === 'Tab') {
      // The list is one stop: Tab leaves it, back on the row that opened it.
      event.preventDefault();
      onClose();
      anchor.focus();
    }
  };
  const separatorAt = matches.findIndex((choice) => choice.value === LOOSE_PROJECT_ID);
  return (
    <Popover anchor={anchor} onClose={onClose} role="dialog" label="Filter by project" className="menu project-filter-menu" onKeyDown={keys}>
      <label className="nav-row nav-row--field project-filter-menu__search">
        <Search className="i" aria-hidden="true" />
        <input
          type="text" role="combobox" autoFocus value={query} placeholder="Search projects…" aria-label="Search projects" spellCheck={false}
          autoComplete="off" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`}
          aria-activedescendant={matches[active] ? optionId(active) : undefined}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        />
      </label>
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Projects" className="project-filter-menu__list">
        {matches.map((choice, index) => (
          <div
            key={choice.value ?? ''} id={optionId(index)} role="option" aria-selected={choice.value === value}
            data-active={index === active || undefined}
            // A thin rule sets the loose diagrams apart from the projects, as in the sidebar.
            data-divided={(index === separatorAt && index > 0) || undefined}
            className="project-filter-menu__option"
            // A press keeps the focus in the search field; the click chooses.
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => { if (index !== active) setActive(index); }}
            onClick={() => onPick(choice.value)}
          >
            {choice.icon}
            <span className="menu__label">{choice.label}</span>
            {choice.value === value && <Check className="i project-filter-menu__check" aria-hidden="true" />}
          </div>
        ))}
      </div>
      {matches.length === 0 && <p className="menu__empty" role="status">No matching projects.</p>}
    </Popover>
  );
}
