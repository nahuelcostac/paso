import { useRef } from 'react';
import { Check, FolderOpen, FolderPlus, X } from 'lucide-react';
import type { WorkspaceInfo } from '../lib/api';
import { Popover, useMenuKeys } from './Popover';

type Props = {
  anchor: HTMLElement;
  /** Where it opens: beside the activity bar's button, on its right. */
  side?: 'below' | 'right';
  workspaces: WorkspaceInfo[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onReveal: () => void;
  onRemove: () => void;
  onClose: () => void;
};

/**
 * The activity bar's workspace switcher: every workspace, the open one checked, then the actions. A folder that is gone is
 * listed but cannot be opened. The default workspace, Paso's own folder, cannot be taken off the list.
 */
export function WorkspaceMenu({ anchor, side, workspaces, activeId, onSwitch, onAdd, onReveal, onRemove, onClose }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(list);
  const active = workspaces.find((workspace) => workspace.id === activeId);
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <Popover anchor={anchor} side={side} onClose={onClose} role="menu" label="Workspaces" className="menu menu--workspaces" onKeyDown={keys}>
      <div ref={list}>
        {workspaces.map((workspace) => {
          const checked = workspace.id === activeId;
          return (
            <button
              key={workspace.id} type="button" role="menuitemradio" aria-checked={checked}
              aria-disabled={!workspace.available || undefined} title={workspace.path}
              onClick={workspace.available ? run(() => { if (!checked) onSwitch(workspace.id); }) : undefined}
            >
              <span className="menu__check">{checked && <Check className="i" aria-hidden="true" />}</span>
              <span className="menu__label">{workspace.name}</span>
              {!workspace.available && <span className="menu__meta">Unavailable</span>}
            </button>
          );
        })}
        <hr />
        <button type="button" role="menuitem" onClick={run(onAdd)}><FolderPlus className="i" aria-hidden="true" />New workspace…</button>
        <button type="button" role="menuitem" onClick={run(onReveal)}><FolderOpen className="i" aria-hidden="true" />Open folder</button>
        {active && !active.default && (
          <button type="button" role="menuitem" onClick={run(onRemove)} title="The folder and its projects stay where they are.">
            <X className="i" aria-hidden="true" />Remove from list
          </button>
        )}
      </div>
    </Popover>
  );
}
