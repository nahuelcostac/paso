import { useRef, useState } from 'react';
import { EllipsisVertical, FolderInput, Pencil, Plus, Trash2 } from 'lucide-react';
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
  onDelete: (sceneId: string) => Promise<void>;
  transfer?: SceneTransfer;
};

/**
 * Moving a scene, which the sidebar runs: dragging it to another place in its project, onto another project or the loose
 * diagrams, or “Move to…”.
 */
export type SceneTransfer = {
  drag: (scene: Scene) => { handlers: DragHandlers; dragging: boolean };
  /** True once for the click that ends a drag, which must not also open the scene. */
  consumeClick: () => boolean;
  move: (scene: Scene) => void;
  /** Where a scene dragged here, from this project or another, would land next to this one: a line above or below it. */
  insert: (sceneId: string) => 'before' | 'after' | undefined;
};

const failure = (error: unknown) => error instanceof Error ? error.message : 'Try again.';
const stepsText = (count: number) => count === 0 ? 'The scene has no steps' : count === 1 ? 'This deletes 1 step' : `This deletes ${count} steps`;

function SceneMenu({ anchor, name, onClose, onRename, onTransfer, onDelete }: {
  anchor: HTMLElement; name: string; onClose: () => void; onRename: () => void; onTransfer?: () => void; onDelete: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(list);
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" role="menu" label={`Actions for the scene “${name}”`} className="menu" onKeyDown={keys}>
      <div ref={list}>
        <button type="button" role="menuitem" onClick={run(onRename)}><Pencil className="i" aria-hidden="true" />Rename</button>
        {onTransfer && <button type="button" role="menuitem" onClick={run(onTransfer)}><FolderInput className="i" aria-hidden="true" />Move to…</button>}
        <button type="button" role="menuitem" className="menu__danger" onClick={run(onDelete)}><Trash2 className="i" aria-hidden="true" />Delete…</button>
      </div>
    </Popover>
  );
}

/**
 * The open diagram's scenes, under its row in the sidebar, like pages: a click opens a scene on the board, and each has a
 * menu to rename, move or delete it. “Add scene” closes the list. Dragging a scene puts it above or below another
 * one of the list, or moves it onto another project or the loose diagrams.
 */
export function SceneList({ diagram, scenes, currentId, busy, onSelect, onCreate, onRename, onDelete, transfer }: Props) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ scene: Scene; error?: string; busy?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuScene = menu ? scenes.find((scene) => scene.id === menu.id) : undefined;

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: undefined });
    try { await onDelete(deleting.scene.id); setDeleting(null); }
    catch (failed) { setDeleting({ scene: deleting.scene, error: `Couldn't delete the scene. ${failure(failed)}` }); }
  };

  return (
    <>
      <ul className="scene-list" aria-label={`Scenes of ${diagram}`}>
        {scenes.map((scene, index) => {
          const current = scene.id === currentId;
          const drag = transfer?.drag(scene);
          return (
            // A scene dragged here lands above or below this one.
            <li key={scene.id} data-drop-scene={scene.id} data-drop-index={index} data-insert={transfer?.insert(scene.id)}>
              <div className="scene-row" data-current={current} data-dragging={drag?.dragging || undefined}>
                <span className="scene-row__num" aria-hidden="true">{index + 1}</span>
                {renaming === scene.id ? (
                  <div className="scene-row__text">
                    <NameField
                      initial={scene.name} label={`Name of scene ${index + 1}`}
                      onSave={async (name) => {
                        try { await onRename(scene.id, name); setRenaming(null); }
                        catch (failed) { throw new Error(`Couldn't rename the scene. ${failure(failed)}`); }
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
                      <span className="visually-hidden">Scene {index + 1}: </span><span className="scene-row__name">{scene.name}</span>
                    </button>
                    <button
                      type="button" className="scene-row__more" aria-haspopup="menu" aria-expanded={menu?.id === scene.id}
                      aria-label={`Actions for the scene “${scene.name}”`}
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
            <Plus className="i" aria-hidden="true" />Add scene
          </button>
        </li>
      </ul>
      {error && <p className="scene-list__error" role="alert">{error}</p>}
      {menu && menuScene && (
        <SceneMenu
          anchor={menu.anchor} name={menuScene.name}
          onClose={() => setMenu(null)}
          onRename={() => { setError(null); setRenaming(menuScene.id); }}
          onTransfer={transfer ? () => { setError(null); transfer.move(menuScene); } : undefined}
          onDelete={() => setDeleting({ scene: menuScene })}
        />
      )}
      {deleting && (
        <Dialog title={`Delete the scene “${deleting.scene.name}”?`} onClose={() => { if (!deleting.busy) setDeleting(null); }}>
          <p className="dialog__text">{stepsText(deleting.scene.stepIds.length)}. This can't be undone.</p>
          {deleting.error && <p className="dialog__error" role="alert">{deleting.error}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus disabled={deleting.busy} onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="btn btn--danger" disabled={deleting.busy} onClick={() => void confirmDelete()}>Delete scene</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
