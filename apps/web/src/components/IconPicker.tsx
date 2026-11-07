import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { Popover } from './Popover';
import { searchIcons, DEFAULT_ICON } from '../lib/icons';

type Props = { anchor: HTMLElement; current: string | undefined; onPick: (name: string) => void; onClose: () => void };

/** Opens from a project's tile: a search field and a grid of Lucide icons. */
export function IconPicker({ anchor, current, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const results = searchIcons(query);
  const status = useId();
  const selected = current ?? DEFAULT_ICON;
  return (
    <Popover anchor={anchor} onClose={onClose} role="dialog" label="Icono del proyecto" className="picker">
      <div className="picker__title">Icono del proyecto</div>
      <label className="picker__search">
        <Search className="i" aria-hidden="true" />
        <input
          autoFocus
          type="search"
          value={query}
          placeholder="Buscar icono…"
          aria-label="Buscar icono"
          aria-describedby={status}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p id={status} className="visually-hidden" aria-live="polite">
        {results.length === 0 ? 'Sin resultados' : `${results.length} iconos`}
      </p>
      {results.length === 0 ? (
        <p className="picker__empty">Ningún icono coincide con «{query.trim()}».</p>
      ) : (
        <div className="picker__grid">
          {results.map(({ name, icon: Icon, label }) => (
            <button key={name} type="button" aria-label={label} title={label} aria-pressed={name === selected} onClick={() => onPick(name)}>
              <Icon className="i" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
