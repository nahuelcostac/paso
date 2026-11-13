import { useRef, type ReactNode } from 'react';
import { EllipsisVertical, TriangleAlert } from 'lucide-react';
import { ProjectIcon } from '../lib/icons';
import { explainProjectError, formatSize } from '../lib/format';
import type { ProjectRow as Row } from '../state/projects-store';
import { NameField } from './NameField';

type Props = {
  row: Row;
  current: boolean;
  /** Its scenes show under it. */
  expanded?: boolean;
  renaming: boolean;
  onOpen: () => void;
  onIcon: (anchor: HTMLElement) => void;
  onMenu: (anchor: HTMLElement) => void;
  onRename: (name: string) => Promise<void>;
  onRenameCancel: () => void;
  onRenameAbandon: (message: string) => void;
  /** A loose diagram is being dragged over this project: dropping it here moves it in. */
  dropTarget?: boolean;
  /** Under an expanded project: its scenes. */
  children?: ReactNode;
};

/**
 * One line per project: its icon, which opens the icon picker, then its name. The menu appears on hover or focus.
 * The size is read out with the name and shown as a tooltip, so the list stays one line per project.
 */
export function ProjectRow({ row, current, expanded = false, renaming, onOpen, onIcon, onMenu, onRename, onRenameCancel, onRenameAbandon, dropTarget = false, children }: Props) {
  const tile = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);

  if (row.kind === 'error') {
    const { short } = explainProjectError(row.message);
    return (
      <li>
        <div className="project project--error" data-current={current}>
          <span className="project__tile"><TriangleAlert className="i" aria-hidden="true" /></span>
          <button type="button" className="project__open" aria-current={current ? 'true' : undefined} onClick={onOpen} title={row.message}>
            <span className="project__name">{row.id}</span>
            <span className="visually-hidden">, {short}</span>
          </button>
        </div>
      </li>
    );
  }

  const { name, icon } = row.project;
  const size = formatSize(row.scenes, row.steps);
  return (
    // The whole item, its scene list included, takes a dragged loose diagram.
    <li data-drop-project={row.id} data-drop={dropTarget || undefined}>
      <div className="project" data-current={current}>
        <button ref={tile} type="button" className="project__tile" aria-haspopup="dialog" aria-label={`Cambiar el icono de ${name}`} onClick={() => onIcon(tile.current!)}>
          <ProjectIcon name={icon} />
        </button>
        {renaming ? (
          <div className="project__text">
            <NameField initial={name} label={`Nombre de ${name}`} onSave={onRename} onCancel={onRenameCancel} onAbandon={onRenameAbandon} />
          </div>
        ) : (
          <button type="button" className="project__open" aria-current={current ? 'true' : undefined} aria-expanded={expanded} onClick={onOpen} title={`${name} · ${size}`}>
            <span className="project__name">{name}</span>
            <span className="visually-hidden">, {size}</span>
          </button>
        )}
        {!renaming && (
          <button ref={more} type="button" className="project__more" aria-haspopup="menu" aria-label={`Más acciones de ${name}`} onClick={() => onMenu(more.current!)}>
            <EllipsisVertical className="i" aria-hidden="true" />
          </button>
        )}
      </div>
      {children}
    </li>
  );
}
