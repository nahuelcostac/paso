import { useRef } from 'react';
import { Ellipsis, TriangleAlert } from 'lucide-react';
import { ProjectIcon } from '../lib/icons';
import { explainProjectError, formatSize } from '../lib/format';
import type { ProjectRow as Row } from '../state/projects-store';
import { NameField } from './NameField';

type Props = {
  row: Row;
  current: boolean;
  renaming: boolean;
  onOpen: () => void;
  onIcon: (anchor: HTMLElement) => void;
  onMenu: (anchor: HTMLElement) => void;
  onRename: (name: string) => Promise<void>;
  onRenameCancel: () => void;
  onRenameAbandon: (message: string) => void;
};

export function ProjectRow({ row, current, renaming, onOpen, onIcon, onMenu, onRename, onRenameCancel, onRenameAbandon }: Props) {
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
            <span className="project__meta project__meta--error">{short}</span>
          </button>
        </div>
      </li>
    );
  }

  const { name, icon } = row.project;
  return (
    <li>
      <div className="project" data-current={current}>
        <button ref={tile} type="button" className="project__tile" aria-haspopup="dialog" aria-label={`Cambiar el icono de ${name}`} onClick={() => onIcon(tile.current!)}>
          <ProjectIcon name={icon} />
        </button>
        {renaming ? (
          <div className="project__text">
            <NameField initial={name} label={`Nombre de ${name}`} onSave={onRename} onCancel={onRenameCancel} onAbandon={onRenameAbandon} />
            <span className="project__meta">{formatSize(row.scenes, row.steps)}</span>
          </div>
        ) : (
          <button type="button" className="project__open" aria-current={current ? 'true' : undefined} onClick={onOpen}>
            <span className="project__name">{name}</span>
            <span className="project__meta">{formatSize(row.scenes, row.steps)}</span>
          </button>
        )}
        {!renaming && (
          <button ref={more} type="button" className="project__more" aria-haspopup="menu" aria-label={`Más acciones de ${name}`} onClick={() => onMenu(more.current!)}>
            <Ellipsis className="i" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
