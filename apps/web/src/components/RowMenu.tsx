import { useEffect, useRef } from 'react';
import { FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { Popover } from './Popover';

type Props = { anchor: HTMLElement; name: string; onRename: () => void; onReveal: () => void; onDelete: () => void; onClose: () => void };

export function RowMenu({ anchor, name, onRename, onReveal, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => { items()[0]?.focus(); }, []);
  const move = (delta: number | 'first' | 'last') => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = delta === 'first' ? 0 : delta === 'last' ? all.length - 1 : (at + delta + all.length) % all.length;
    all[next]?.focus();
  };
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      align="end"
      role="menu"
      label={`Acciones de ${name}`}
      className="menu"
      onKeyDown={(event) => {
        const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
        if (event.key in keys) { event.preventDefault(); move(keys[event.key]); }
      }}
    >
      <div ref={ref}>
        <button type="button" role="menuitem" onClick={() => { onClose(); onRename(); }}><Pencil className="i" aria-hidden="true" />Renombrar</button>
        <button type="button" role="menuitem" onClick={() => { onClose(); onReveal(); }}><FolderOpen className="i" aria-hidden="true" />Abrir carpeta</button>
        <button type="button" role="menuitem" className="menu__danger" onClick={() => { onClose(); onDelete(); }}><Trash2 className="i" aria-hidden="true" />Eliminar…</button>
      </div>
    </Popover>
  );
}
