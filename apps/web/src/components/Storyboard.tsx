import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Layers, Plus, TriangleAlert, X } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import type { Route } from '../lib/route';
import { useTheme } from '../editor/use-theme';
import type { ThumbnailCache } from '../editor/thumbnails';
import { ActionError, type ServiceEvent } from '../state/projects-store';
import { StoryboardStore, useStoryboard, type SceneEntry } from '../state/storyboard-store';
import { Dialog } from './Dialog';
import { SceneSection } from './SceneSection';
import '../styles/storyboard.css';

type Props = {
  api: ApiClient;
  projectId: string;
  projectName: string;
  /** "4 scenes · 17 steps", as the project list shows it, so the two never disagree. */
  listedSize: string;
  /** A loose diagram: the reserved project is shown limited to this one scene. */
  onlySceneId?: string;
  events: (listener: (event: ServiceEvent) => void) => () => void;
  thumbnails: ThumbnailCache;
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** The agent's marks: `changed` for its work, `working` for the step it is changing now. */
  stepAgentStates?: Record<string, 'working' | 'changed'>;
  /** The app's own failures that have no other place here, such as a step that could not be saved. */
  notices?: React.ReactNode;
  /** The view switch, left of Present in the top right corner, as on the board. */
  views?: React.ReactNode;
  /** Present, over the top right corner: the same corner as on the board. */
  corner?: React.ReactNode;
  /** Saves a step's title, through the steps the Canvas may have open. */
  renameStep?: (target: { projectId: string; sceneId: string; stepId: string }, title: string) => Promise<void>;
};

const reasonText = (error: unknown) => error instanceof ActionError ? error.message : 'Try again.';

/** `order` with the item at `from` moved to sit before the item that was at `to` (0..length). */
function insertAt(order: string[], from: number, to: number) {
  const next = order.filter((_, index) => index !== from);
  next.splice(to > from ? to - 1 : to, 0, order[from]);
  return next;
}

/**
 * The Studio: the selected scene at a glance, its steps as cards with thumbnails, beside the chat that works on it.
 * Studio opens it from the activity bar. Diagram, a step or Escape goes back to the board.
 */
export function Storyboard({ api, projectId, projectName, listedSize, onlySceneId, events, thumbnails, route, navigate, stepAgentStates, notices, views, corner, renameStep }: Props) {
  const store = useMemo(() => new StoryboardStore(api, projectId, events), [api, projectId, events]);
  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  const state = useStoryboard(store);
  const theme = useTheme();

  const [board, setBoard] = useState<HTMLElement | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SceneEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [creating, setCreating] = useState(false);

  // A new order shown before it is saved, while a scene is held by the keyboard or dragged.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; drop: number; moved: boolean } | null>(null);
  const dragState = useRef<{ id: string; pointerId: number; y: number } | null>(null);

  const scenes = useMemo(() => {
    const listed = onlySceneId ? state.scenes.filter((scene) => scene.id === onlySceneId) : state.scenes;
    if (!draft) return listed;
    const byId = new Map(listed.map((scene) => [scene.id, scene]));
    const ordered = draft.map((id) => byId.get(id)).filter((scene): scene is SceneEntry => !!scene);
    return ordered.length === listed.length ? ordered : listed;
  }, [draft, state.scenes, onlySceneId]);
  const order = useMemo(() => scenes.map((scene) => scene.id), [scenes]);

  const run = async (action: () => Promise<unknown>, what: string) => {
    try { await action(); setNotice(null); return true; }
    catch (error) { setNotice(`Couldn't ${what}. ${reasonText(error)}`); return false; }
  };

  const createScene = async () => {
    if (creating) return;
    setCreating(true);
    await run(async () => { const id = await store.createScene(); setRenamingId(id); }, 'create the scene');
    setCreating(false);
  };
  useEffect(() => {
    if (renamingId) board?.querySelector(`[data-scene-id="${renamingId}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [renamingId, board]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await store.deleteScene(deleting.id);
      setDeleting(null); setNotice(null);
      title.current?.focus();
    } catch (error) { setDeleteError(`Couldn't delete the scene. ${reasonText(error)}`); }
    finally { setDeleteBusy(false); }
  };
  const closeDelete = () => { if (!deleteBusy) { setDeleting(null); setDeleteError(null); } };

  const save = (next: string[]) => run(() => store.reorderScenes(next), 'reorder the scenes');
  const moveScene = (id: string, delta: -1 | 1) => {
    const from = order.indexOf(id);
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    void save(next);
    setAnnouncement(`Scene moved to position ${to + 1} of ${order.length}.`);
  };

  // ---- Keyboard: Enter or Space picks a scene up, arrows move it, Enter or Space drops it, Escape puts it back.
  const dropGrabbed = (keep: boolean) => {
    if (!grabbed) return;
    const next = draft;
    setGrabbed(null);
    if (keep && next && next.join() !== state.scenes.map((scene) => scene.id).join()) { void save(next); setDraft(null); setAnnouncement(`Scene dropped at position ${next.indexOf(grabbed) + 1} of ${next.length}.`); }
    else { setDraft(null); if (!keep) setAnnouncement('Reorder canceled.'); }
  };
  const gripKeyDown = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (grabbed === id) dropGrabbed(true);
      else {
        setGrabbed(id); setDraft(order);
        setAnnouncement(`Scene ${order.indexOf(id) + 1} of ${order.length} picked up. Up and down arrows to move it, Enter to drop it, Escape to cancel.`);
      }
      return;
    }
    if (grabbed !== id) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dropGrabbed(false); return; }
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    const from = order.indexOf(id);
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    setDraft(next);
    setAnnouncement(`Position ${to + 1} of ${order.length}.`);
  };
  // Moving a scene moves its DOM node, which can take focus with it: put focus back on its handle.
  useEffect(() => { if (grabbed) grips.current.get(grabbed)?.focus(); }, [grabbed, draft]);
  const gripBlur = (id: string) => () => {
    if (grabbed !== id) return;
    // Focus that left for good drops the scene where it is; focus that is only being moved with the node does not.
    setTimeout(() => { if (document.activeElement !== grips.current.get(id)) dropGrabbed(true); }, 0);
  };

  // ---- Pointer: drag the handle. The scene stays in place and a line shows where it will land.
  const dropIndexAt = useCallback((y: number) => {
    const sections = [...(board?.querySelectorAll<HTMLElement>('[data-scene-id]') ?? [])];
    let index = 0;
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (y > rect.top + rect.height / 2) index += 1; else break;
    }
    return index;
  }, [board]);
  const gripPointerDown = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || grabbed) return;
    dragState.current = { id, pointerId: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ id, drop: dropIndexAt(event.clientY), moved: false });
  };
  const gripPointerMove = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragState.current;
    if (!current || current.id !== id || current.pointerId !== event.pointerId) return;
    current.y = event.clientY;
    setDrag({ id, drop: dropIndexAt(event.clientY), moved: true });
  };
  const gripPointerEnd = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragState.current;
    if (!current || current.id !== id || current.pointerId !== event.pointerId) return;
    dragState.current = null;
    const to = dropIndexAt(event.clientY);
    const moved = drag?.moved;
    setDrag(null);
    if (event.type === 'pointercancel' || !moved) return;
    const from = order.indexOf(id);
    if (to === from || to === from + 1) return;
    void save(insertAt(order, from, to));
    setAnnouncement(`Scene moved to position ${(to > from ? to : to + 1)} of ${order.length}.`);
  };
  // Near the top or bottom edge a drag scrolls the board, so a scene can travel further than the screen.
  useEffect(() => {
    if (!drag || !board) return;
    let frame = 0;
    const tick = () => {
      const current = dragState.current;
      if (current) {
        const rect = board.getBoundingClientRect();
        const edge = 80;
        const delta = current.y < rect.top + edge ? -Math.ceil((rect.top + edge - current.y) / 5) : current.y > rect.bottom - edge ? Math.ceil((current.y - (rect.bottom - edge)) / 5) : 0;
        if (delta) { board.scrollTop += delta; setDrag((now) => now && { ...now, drop: dropIndexAt(current.y) }); }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { dragState.current = null; setDrag(null); } };
    window.addEventListener('keydown', escape);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', escape); };
  }, [drag?.id, board, dropIndexAt]);

  const dropMarker = (index: number): 'before' | 'after' | undefined => {
    if (!drag) return undefined;
    const from = order.indexOf(drag.id);
    if (!drag.moved || drag.drop === from || drag.drop === from + 1) return undefined;
    if (drag.drop === index) return 'before';
    if (drag.drop === order.length && index === order.length - 1) return 'after';
    return undefined;
  };

  const back = () => navigate({ ...route, view: 'canvas' });
  // The Studio shows one scene: the one selected in the sidebar, which is also the one the chat works on. Without one
  // in the address, the first scene is selected, so later reorders do not change what is on show.
  const selectedScene = scenes.find((entry) => entry.id === route.sceneId) ?? scenes[0];
  useEffect(() => {
    if (state.phase !== 'ready' || !selectedScene || selectedScene.id === route.sceneId) return;
    navigate({ ...route, sceneId: selectedScene.id, stepId: selectedScene.stepIds[0] }, { replace: true });
  }, [state.phase, selectedScene, route, navigate]);
  // Opened from the board without the switch (a shortcut, the address): focus lands on the title, so Escape and Tab work
  // from here. Opened with the switch, the focus stays on it.
  useEffect(() => {
    if (document.activeElement === document.body) title.current?.focus({ preventScroll: true });
  }, []);
  return (
    <main
      className="board" aria-label="Studio" aria-busy={state.phase === 'loading'} data-dragging={drag?.moved || undefined} ref={setBoard}
      onKeyDown={(event) => {
        // Escape closes the overview, unless it is ending something here first: a rename, a drag, a held scene.
        if (event.key !== 'Escape' || event.defaultPrevented || renamingId || grabbed || drag || deleting) return;
        if ((event.target as HTMLElement).closest('input, textarea, [role="menu"], [role="dialog"], [role="alertdialog"]')) return;
        back();
      }}
    >
      <div className="canvas__corner board__corner">{views}{corner}</div>
      {notices && <div className="board__top">{notices}</div>}
      <div className="board__head">
        <div className="board__heading">
          <h1 className="board__title" tabIndex={-1} ref={title}>{projectName}</h1>
          <p className="board__meta">{listedSize}</p>
        </div>
      </div>

      {notice && (
        <div className="notice notice--error board__notice" role="alert">
          <TriangleAlert className="i" aria-hidden="true" />
          <span>{notice}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X className="i" aria-hidden="true" /></button>
        </div>
      )}

      {state.phase === 'loading' && (
        <div className="scene" aria-hidden="true">
          <div className="scene__head"><span className="skeleton skeleton--scene" /></div>
          <div className="scene__steps">{[0, 1, 2, 3].map((n) => <div key={n} className="frame"><span className="frame__paper"><span className="frame__placeholder" /></span></div>)}</div>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="board__empty" role="status">
          <div className="main-message__icon"><TriangleAlert className="i" aria-hidden="true" /></div>
          <h2 className="board__empty-title">Couldn't load the scenes</h2>
          <p>Paso couldn't read this project. Check that the local service is still running.</p>
          <button type="button" className="btn btn--soft" onClick={() => store.retry()}>Retry</button>
        </div>
      )}

      {state.phase === 'ready' && scenes.length === 0 && (
        <div className="board__empty">
          <div className="main-message__icon"><Layers className="i" aria-hidden="true" /></div>
          <h2 className="board__empty-title">This project has no scenes yet</h2>
          <p>A scene groups the steps of one part of the explanation. Create the first one and start adding steps.</p>
          <button type="button" className="btn btn--soft btn--large" disabled={creating} onClick={() => void createScene()}><Plus className="i" aria-hidden="true" />Create the first scene</button>
        </div>
      )}

      {selectedScene && [selectedScene].map((scene) => ({ scene, index: scenes.indexOf(scene) })).map(({ scene, index }) => (
        <SceneSection
          key={scene.id}
          manage={false}
          scene={scene}
          index={index}
          total={scenes.length}
          state={state}
          store={store}
          api={api}
          cache={thumbnails}
          theme={theme}
          root={board}
          currentStepId={route.sceneId === scene.id ? route.stepId : undefined}
          stepAgentStates={stepAgentStates}
          renaming={renamingId === scene.id}
          grabbed={grabbed === scene.id}
          dragging={drag?.id === scene.id && drag.moved}
          dropMarker={dropMarker(index)}
          onOpenStep={(stepId) => navigate({ projectId, view: 'canvas', sceneId: scene.id, stepId })}
          onRenameStep={renameStep ? async (stepId, title) => {
            await renameStep({ projectId, sceneId: scene.id, stepId }, title);
            store.showTitle(stepId, title);
            setNotice(null);
          } : undefined}
          onAddStep={async () => { await run(() => store.createStep(scene.id), 'add the step'); }}
          onRename={async (name) => {
            try { await store.renameScene(scene.id, name); setRenamingId(null); setNotice(null); }
            catch (error) { throw new Error(`Couldn't rename the scene. ${reasonText(error)}`); }
          }}
          onRenameStart={() => { setNotice(null); setRenamingId(scene.id); }}
          onRenameEnd={() => setRenamingId(null)}
          onRenameAbandon={(message) => { setRenamingId(null); setNotice(message); }}
          onMove={(delta) => moveScene(scene.id, delta)}
          onDelete={() => { setDeleteError(null); setDeleting(scene); }}
          onGripKeyDown={gripKeyDown(scene.id)}
          onGripBlur={gripBlur(scene.id)}
          onGripPointerDown={gripPointerDown(scene.id)}
          onGripPointerMove={gripPointerMove(scene.id)}
          onGripPointerEnd={gripPointerEnd(scene.id)}
          registerGrip={(element) => { if (element) grips.current.set(scene.id, element); else grips.current.delete(scene.id); }}
        />
      ))}

      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>

      {deleting && (
        <Dialog title={`Delete the scene “${deleting.name}”?`} onClose={closeDelete}>
          <p className="dialog__text">
            {deleting.stepIds.length === 0 ? 'The scene has no steps' : deleting.stepIds.length === 1 ? 'This deletes 1 step' : `This deletes ${deleting.stepIds.length} steps`}. This can't be undone.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={closeDelete}>Cancel</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>Delete scene</button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
