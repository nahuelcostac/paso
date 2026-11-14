import { useRef } from 'react';
import { Check, FolderOpen, FolderPlus, X } from 'lucide-react';
import type { WorkspaceInfo } from '../lib/api';
import { Popover, useMenuKeys } from './Popover';

type Props = {
  anchor: HTMLElement;
  workspaces: WorkspaceInfo[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onReveal: () => void;
  onRemove: () => void;
  onClose: () => void;
};

/**
 * The sidebar's workspace switcher: every workspace, the open one checked, then the actions. A folder that is gone is
 * listed but cannot be opened. The default workspace, Paso's own folder, cannot be taken off the list.
 */
export function WorkspaceMenu({ anchor, workspaces, activeId, onSwitch, onAdd, onReveal, onRemove, onClose }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(list);
  const active = workspaces.find((workspace) => workspace.id === activeId);
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <Popover anchor={anchor} onClose={onClose} role="menu" label="Workspaces" className="menu menu--workspaces" onKeyDown={keys}>
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
              {!workspace.available && <span className="menu__meta">No disponible</span>}
            </button>
          );
        })}
        <hr />
        <button type="button" role="menuitem" onClick={run(onAdd)}><FolderPlus className="i" aria-hidden="true" />Nuevo workspace…</button>
        <button type="button" role="menuitem" onClick={run(onReveal)}><FolderOpen className="i" aria-hidden="true" />Abrir carpeta</button>
        {active && !active.default && (
          <button type="button" role="menuitem" onClick={run(onRemove)} title="La carpeta y sus diagramas se quedan donde están.">
            <X className="i" aria-hidden="true" />Quitar de la lista
          </button>
        )}
      </div>
    </Popover>
  );
}
