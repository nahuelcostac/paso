import { useEffect, useRef, type ReactNode } from 'react';
import { Popover } from './Popover';

export type MenuAction = { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean };
type Props = { anchor: HTMLElement; label: string; actions: MenuAction[]; onClose: () => void };

/** A menu of actions in a popover. Arrow keys move, Home and End jump, Escape closes. */
export function ActionMenu({ anchor, label, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
  useEffect(() => { items()[0]?.focus(); }, []);
  const move = (delta: number | 'first' | 'last') => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[delta === 'first' ? 0 : delta === 'last' ? all.length - 1 : (at + delta + all.length) % all.length]?.focus();
  };
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      align="end"
      role="menu"
      label={label}
      className="menu"
      onKeyDown={(event) => {
        const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
        if (event.key in keys) { event.preventDefault(); move(keys[event.key]); }
      }}
    >
      <div ref={ref}>
        {actions.map((action) => (
          <button key={action.label} type="button" role="menuitem" disabled={action.disabled} className={action.danger ? 'menu__danger' : undefined} onClick={() => { onClose(); anchor.focus(); action.onSelect(); }}>
            {action.icon}{action.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}
