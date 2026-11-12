import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, EllipsisVertical, FolderInput, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Scene } from '@paso/shared';
import { Dialog } from './Dialog';
import type { DragHandlers } from './LooseRow';
import { NameField } from './NameField';
import { Popover, useMenuKeys } from './Popover';

type Props = {
  /** The diagram the scenes belong to, for the list's name. */
  diagram: string;
  scenes: Scene[];
  currentId: string | undefined;
  busy: boolean;
  onSelect: (sceneId: string) => void;
  onCreate: () => void;
  /** Each rejects with the words to show if it failed. */
  onRename: (sceneId: string, name: string) => Promise<void>;
  onMove: (sceneId: string, delta: -1 | 1) => Promise<void>;
  onDelete: (sceneId: string) => Promise<void>;
  transfer?: SceneTransfer;
};

/** Moving a scene elsewhere, which the sidebar runs: dragging it onto a project or the loose diagrams, or «Mover a…». */
export type SceneTransfer = {
  drag: (scene: Scene) => { handlers: DragHandlers; dragging: boolean };
  /** True once for the click that ends a drag, which must not also open the scene. */
  consumeClick: () => boolean;
  move: (scene: Scene) => void;
  /** Where a scene dragged here would land next to this one, shown as a line above or below it. */
  insert: (sceneId: string) => 'before' | 'after' | undefined;
};

const failure = (error: unknown) => error instanceof Error ? error.message : 'Inténtalo de nuevo.';
const stepsText = (count: number) => count === 0 ? 'La escena no tiene pasos' : count === 1 ? 'Se borrará 1 paso' : `Se borrarán ${count} pasos`;

function SceneMenu({ anchor, name, first, last, onClose, onRename, onMove, onTransfer, onDelete }: {
  anchor: HTMLElement; name: string; first: boolean; last: boolean; onClose: () => void;
  onRename: () => void; onMove: (delta: -1 | 1) => void; onTransfer?: () => void; onDelete: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(list);
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" role="menu" label={`Acciones de la escena «${name}»`} className="menu" onKeyDown={keys}>
      <div ref={list}>
        <button type="button" role="menuitem" onClick={run(onRename)}><Pencil className="i" aria-hidden="true" />Renombrar</button>
        <button type="button" role="menuitem" disabled={first} onClick={run(() => onMove(-1))}><ArrowUp className="i" aria-hidden="true" />Subir</button>
        <button type="button" role="menuitem" disabled={last} onClick={run(() => onMove(1))}><ArrowDown className="i" aria-hidden="true" />Bajar</button>
        {onTransfer && <button type="button" role="menuitem" onClick={run(onTransfer)}><FolderInput className="i" aria-hidden="true" />Mover a…</button>}
        <button type="button" role="menuitem" className="menu__danger" onClick={run(onDelete)}><Trash2 className="i" aria-hidden="true" />Eliminar…</button>
      </div>
    </Popover>
  );
}

/**
 * The open diagram's scenes, under its row in the sidebar, like pages: a click opens a scene on the board, and each has a
 * menu to rename, move or delete it. «Añadir diagrama» closes the list. A scene can be dragged onto another project, or
 * onto the loose diagrams, to move it there.
 */
export function SceneList({ diagram, scenes, currentId, busy, onSelect, onCreate, onRename, onMove, onDelete, transfer }: Props) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ scene: Scene; error?: string; busy?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuScene = menu ? scenes.find((scene) => scene.id === menu.id) : undefined;
  const at = (id: string) => scenes.findIndex((scene) => scene.id === id);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: undefined });
    try { await onDelete(deleting.scene.id); setDeleting(null); }
    catch (failed) { setDeleting({ scene: deleting.scene, error: `No se pudo eliminar la escena. ${failure(failed)}` }); }
  };

  return (
    <>
      <ul className="scene-list" aria-label={`Escenas de ${diagram}`}>
        {scenes.map((scene, index) => {
          const current = scene.id === currentId;
          const drag = transfer?.drag(scene);
          return (
            // A scene dragged from another project lands above or below this one.
            <li key={scene.id} data-drop-scene={scene.id} data-drop-index={index} data-insert={transfer?.insert(scene.id)}>
              <div className="scene-row" data-current={current} data-dragging={drag?.dragging || undefined}>
                <span className="scene-row__num" aria-hidden="true">{index + 1}</span>
                {renaming === scene.id ? (
                  <div className="scene-row__text">
                    <NameField
                      initial={scene.name} label={`Nombre de la escena ${index + 1}`}
                      onSave={async (name) => {
                        try { await onRename(scene.id, name); setRenaming(null); }
                        catch (failed) { throw new Error(`No se pudo renombrar la escena. ${failure(failed)}`); }
                      }}
                      onCancel={() => setRenaming(null)}
                      onAbandon={(message) => { setRenaming(null); setError(message); }}
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button" className="scene-row__open" aria-current={current ? 'true' : undefined}
                      onClick={() => { if (!transfer?.consumeClick()) onSelect(scene.id); }} {...drag?.handlers}
                    >
                      <span className="visually-hidden">Escena {index + 1}: </span><span className="scene-row__name">{scene.name}</span>
                    </button>
                    <button
                      type="button" className="scene-row__more" aria-haspopup="menu" aria-expanded={menu?.id === scene.id}
                      aria-label={`Acciones de la escena «${scene.name}»`}
                      onClick={(event) => setMenu(menu?.id === scene.id ? null : { id: scene.id, anchor: event.currentTarget })}
                    >
                      <EllipsisVertical className="i" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        <li>
          <button type="button" className="scene-row scene-row--add" disabled={busy} onClick={onCreate}>
            <Plus className="i" aria-hidden="true" />Añadir diagrama
          </button>
        </li>
      </ul>
      {error && <p className="scene-list__error" role="alert">{error}</p>}
      {menu && menuScene && (
        <SceneMenu
          anchor={menu.anchor} name={menuScene.name} first={at(menuScene.id) === 0} last={at(menuScene.id) === scenes.length - 1}
          onClose={() => setMenu(null)}
          onRename={() => { setError(null); setRenaming(menuScene.id); }}
          onMove={(delta) => { setError(null); void onMove(menuScene.id, delta).catch((failed) => setError(`No se pudo mover la escena. ${failure(failed)}`)); }}
          onTransfer={transfer ? () => { setError(null); transfer.move(menuScene); } : undefined}
          onDelete={() => setDeleting({ scene: menuScene })}
        />
      )}
      {deleting && (
        <Dialog title={`¿Eliminar la escena «${deleting.scene.name}»?`} onClose={() => { if (!deleting.busy) setDeleting(null); }}>
          <p className="dialog__text">{stepsText(deleting.scene.stepIds.length)}. No se puede deshacer.</p>
          {deleting.error && <p className="dialog__error" role="alert">{deleting.error}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus disabled={deleting.busy} onClick={() => setDeleting(null)}>Cancelar</button>
            <button type="button" className="btn btn--danger" disabled={deleting.busy} onClick={() => void confirmDelete()}>Eliminar escena</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
