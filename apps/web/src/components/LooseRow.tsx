import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { EllipsisVertical } from 'lucide-react';
import type { LooseDiagram } from '../state/projects-store';
import { NameField } from './NameField';

/** Pointer handlers that let a row be dragged: a loose diagram, or a scene, towards where it should go. */
export type DragHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
};

export const stepCount = (steps: number) => steps === 0 ? 'No steps' : steps === 1 ? '1 step' : `${steps} steps`;

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
  /** Lets the row be dragged onto a project. */
  drag: DragHandlers;
};

/**
 * A loose diagram belongs to no project. Drag its row onto a project to move it there.
 */
export function LooseRow({ diagram, current, renaming, dragging, onOpen, onMenu, onRename, onRenameCancel, onRenameAbandon, drag }: Props) {
  const more = useRef<HTMLButtonElement>(null);
  const { name } = diagram.scene;
  const size = stepCount(diagram.steps);
  return (
    <li>
      <div className="project project--loose" data-current={current} data-dragging={dragging || undefined}>
        {renaming ? (
          <div className="project__text">
            <NameField initial={name} label={`Name of ${name}`} onSave={onRename} onCancel={onRenameCancel} onAbandon={onRenameAbandon} />
          </div>
        ) : (
          <button
            type="button" className="project__open" aria-current={current ? 'true' : undefined} onClick={onOpen}
            title={`${name} · ${size}. Drag it onto a project to move it.`} {...drag}
          >
            <span className="project__name">{name}</span>
            <span className="visually-hidden">, loose diagram, {size}</span>
          </button>
        )}
        {!renaming && (
          <button ref={more} type="button" className="project__more" aria-haspopup="menu" aria-label={`More actions for ${name}`} onClick={() => onMenu(more.current!)}>
            <EllipsisVertical className="i" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
