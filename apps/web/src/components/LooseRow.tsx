import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { EllipsisVertical, Shapes } from 'lucide-react';
import type { LooseDiagram } from '../state/projects-store';
import { NameField } from './NameField';

export const stepCount = (steps: number) => steps === 0 ? 'Sin pasos' : steps === 1 ? '1 paso' : `${steps} pasos`;

type Props = {
  diagram: LooseDiagram;
  current: boolean;
  renaming: boolean;
  /** This row is being dragged towards a project. */
  dragging: boolean;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void;
  onRename: (name: string) => Promise<void>;
  onRenameCancel: () => void;
  onRenameAbandon: (message: string) => void;
  /** Pointer handlers that let the row be dragged onto a project. */
  drag: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
};

/**
 * A loose diagram: one scene that belongs to no project. It reads like a project row, with a fixed icon, and can be
 * dragged onto a project to move it in.
 */
export function LooseRow({ diagram, current, renaming, dragging, onOpen, onMenu, onRename, onRenameCancel, onRenameAbandon, drag }: Props) {
  const more = useRef<HTMLButtonElement>(null);
  const { name } = diagram.scene;
  const size = stepCount(diagram.steps);
  return (
    <li>
      <div className="project project--loose" data-current={current} data-dragging={dragging || undefined}>
        <span className="project__tile" aria-hidden="true"><Shapes className="i" /></span>
        {renaming ? (
          <div className="project__text">
            <NameField initial={name} label={`Nombre de ${name}`} onSave={onRename} onCancel={onRenameCancel} onAbandon={onRenameAbandon} />
          </div>
        ) : (
          <button
            type="button" className="project__open" aria-current={current ? 'true' : undefined} onClick={onOpen}
            title={`${name} · ${size}. Arrástralo a un proyecto para moverlo.`} {...drag}
          >
            <span className="project__name">{name}</span>
            <span className="visually-hidden">, diagrama suelto, {size}</span>
          </button>
        )}
        {!renaming && (
          <button ref={more} type="button" className="project__more" aria-haspopup="menu" aria-label={`Más acciones de ${name}`} onClick={() => onMenu(more.current!)}>
            <EllipsisVertical className="i" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
