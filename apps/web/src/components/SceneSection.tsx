import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Ellipsis, GripVertical, MessageSquarePlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { useGridColumns, useNear } from '../lib/dom-hooks';
import { formatSteps } from '../lib/format';
import type { Theme, ThumbnailCache } from '../editor/thumbnails';
import { sceneKey, type SceneEntry, type StoryboardState, type StoryboardStore } from '../state/storyboard-store';
import { useSceneThumbnails } from '../state/use-scene-thumbnails';
import { ActionMenu } from './ActionMenu';
import { NameField } from './NameField';
import { StepFrame } from './StepFrame';

type Props = {
  scene: SceneEntry;
  /** Position from 0, and how many scenes there are. */
  index: number;
  total: number;
  state: StoryboardState;
  store: StoryboardStore;
  api: ApiClient;
  cache: ThumbnailCache;
  theme: Theme;
  /** The scroll container: thumbnails are drawn once their scene nears it. */
  root: HTMLElement | null;
  currentStepId?: string;
  stepAgentStates?: Record<string, 'working' | 'changed'>;
  renaming: boolean;
  grabbed: boolean;
  dragging: boolean;
  dropMarker?: 'before' | 'after';
  onOpenStep: (stepId: string) => void;
  onAddStep: () => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onRenameStart: () => void;
  onRenameEnd: () => void;
  onRenameAbandon: (message: string) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  onGripKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onGripBlur: () => void;
  onGripPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onGripPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onGripPointerEnd: (event: PointerEvent<HTMLButtonElement>) => void;
  /** False in the Studio, which shows one scene: the sidebar renames, moves and deletes scenes. */
  manage?: boolean;
  /** Names a step: a click on a card's title, or F2 on the card, opens the field. Resolves when saved. */
  onRenameStep?: (stepId: string, title: string) => Promise<void>;
  /**
   * Sends steps to the agent chat, in the scene's order. With it, each card has “Add to chat” on hover or focus, and
   * steps can be selected (⌘/Ctrl-click, Shift-click, Shift and the arrows) to add them all at once.
   */
  onAddToChat?: (stepIds: string[]) => void;
  registerGrip: (element: HTMLButtonElement | null) => void;
};

/** One scene: “Scene 1 of 3” over its title, its step count, then its steps as a grid of numbered cards. */
export function SceneSection(props: Props) {
  const { scene, index, total, state, store, api, cache, theme, root, currentStepId, stepAgentStates, renaming, grabbed, dragging, dropMarker } = props;
  const section = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const [renamingStep, setRenamingStep] = useState<string | null>(null);
  // The selection, for adding steps to the chat. The anchor is where a Shift range starts.
  const [selection, setSelection] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const selectable = Boolean(props.onAddToChat);
  // Focus goes back to the card whose title was being edited.
  const endStepRename = (at: number) => { setRenamingStep(null); requestAnimationFrame(() => items.current[at]?.focus()); };

  const near = useNear(section, root);
  useEffect(() => { if (near) store.ensureSteps(scene.id); }, [near, store, scene.id]);
  const { thumbnails } = useSceneThumbnails({ api, cache, projectId: store.projectId, sceneId: scene.id, theme, key: sceneKey(state, scene), enabled: near });

  const count = scene.stepIds.length;
  const columns = useGridColumns(grid);
  // In the scene's order, and only steps it still has.
  const selected = scene.stepIds.filter((id) => selection.includes(id));
  const toggle = (id: string) => {
    anchor.current = id;
    setSelection((current) => current.includes(id) ? current.filter((other) => other !== id) : [...current, id]);
  };
  /** Selects from the anchor to `id`, as Shift does in a file list; without an anchor, the open step or the first is one. */
  const selectRange = (id: string, from = anchor.current ?? (currentStepId && scene.stepIds.includes(currentStepId) ? currentStepId : id)) => {
    anchor.current = scene.stepIds.includes(from) ? from : id;
    const a = scene.stepIds.indexOf(anchor.current);
    const b = scene.stepIds.indexOf(id);
    setSelection(scene.stepIds.slice(Math.min(a, b), Math.max(a, b) + 1));
  };
  const clearSelection = () => { setSelection([]); anchor.current = null; };
  const addToChat = (ids: string[]) => { props.onAddToChat?.(ids); clearSelection(); };
  const last = Math.min(active, count); // The add slot is the last stop.

  // After renaming, give focus back to the scene's menu, which the field replaced.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) more.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  const move = (event: KeyboardEvent) => {
    const at = items.current.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // Shift extends the selection over the steps; the add slot is never part of it.
    const extend = selectable && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    const end = extend ? count - 1 : count; // index of the add slot, or of the last step while selecting
    if (extend && at >= count) return;
    const target: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + columns, ArrowUp: at - columns, Home: 0, End: end };
    if (!(event.key in target)) return;
    event.preventDefault();
    let next = target[event.key];
    if (next > end) next = event.key === 'ArrowDown' && at < end ? end : at;
    if (next < 0) next = at;
    if (extend) selectRange(scene.stepIds[next], anchor.current ?? scene.stepIds[at]);
    setActive(next);
    items.current[next]?.focus();
  };

  const add = async () => {
    if (adding) return;
    setAdding(true);
    try { await props.onAddStep(); } finally { setAdding(false); }
  };

  const name = scene.name;
  return (
    <section
      ref={section}
      className="scene"
      aria-label={`Scene ${index + 1}: ${name}`}
      data-scene-id={scene.id}
      data-grabbed={grabbed || undefined}
      data-dragging={dragging || undefined}
      data-drop={dropMarker}
    >
      <div className="scene__head">
        <div className="scene__heading">
          <span className="eyebrow scene__num">Scene {index + 1} of {total}</span>
          {renaming ? (
            <div className="scene__rename">
              <NameField initial={name} label={`Name of scene ${index + 1}`} onSave={props.onRename} onCancel={props.onRenameEnd} onAbandon={props.onRenameAbandon} />
            </div>
          ) : <h2 className="scene__title">{name}</h2>}
        </div>
        <span className="scene__meta">{formatSteps(count)}</span>
        {selectable && selected.length > 0 && (
          <div className="scene__selection" role="group" aria-label="Selected steps">
            <span className="scene__selected" aria-live="polite">{selected.length === 1 ? '1 step selected' : `${selected.length} steps selected`}</span>
            <button type="button" className="btn btn--soft" onClick={() => addToChat(selected)}>
              <MessageSquarePlus className="i" aria-hidden="true" />Add to chat
            </button>
            <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={clearSelection}>
              <X className="i" aria-hidden="true" />
            </button>
          </div>
        )}
        {!renaming && props.manage !== false && (
          <span className="scene__tools">
            <button
              ref={props.registerGrip}
              type="button"
              className="scene__tool scene__grip"
              aria-label={`Reorder scene ${index + 1}, ${name}`}
              aria-pressed={grabbed}
              title="Drag, or press Enter and use the arrow keys"
              onKeyDown={props.onGripKeyDown}
              onBlur={props.onGripBlur}
              onPointerDown={props.onGripPointerDown}
              onPointerMove={props.onGripPointerMove}
              onPointerUp={props.onGripPointerEnd}
              onPointerCancel={props.onGripPointerEnd}
            >
              <GripVertical className="i" aria-hidden="true" />
            </button>
            <button ref={more} type="button" className="scene__tool" aria-haspopup="menu" aria-expanded={menu !== null} aria-label={`More actions for scene ${index + 1}, ${name}`} onClick={() => setMenu(menu ? null : more.current)}>
              <Ellipsis className="i" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      <div
        ref={grid} className="scene__steps" role="group" aria-label={`Steps of ${name}`}
        onKeyDown={(event) => {
          // Escape lets the selection go before it closes the Studio.
          if (event.key === 'Escape' && selected.length && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
          move(event);
        }}
      >
        {scene.stepIds.map((id, at) => {
          const title = state.steps[id]?.title;
          const isSelected = selected.includes(id);
          const shortcuts = [props.onRenameStep ? 'F2' : '', selectable ? 'Meta+Space Control+Space' : ''].filter(Boolean).join(' ');
          const frame = (
            <StepFrame
              key={id}
              ref={(element) => { items.current[at] = element; }}
              number={at + 1}
              title={title}
              framed={state.steps[id]?.framed}
              current={id === currentStepId}
              selected={isSelected}
              agentState={stepAgentStates?.[id]}
              svg={thumbnails?.[id]?.svg}
              tabIndex={last === at ? 0 : -1}
              aria-keyshortcuts={shortcuts || undefined}
              onFocus={() => setActive(at)}
              onClick={(event) => {
                // ⌘/Ctrl adds or takes one step from the selection, Shift selects a range; a plain click opens the step.
                if (selectable && (event.metaKey || event.ctrlKey)) { event.preventDefault(); toggle(id); return; }
                if (selectable && event.shiftKey) { event.preventDefault(); selectRange(id); return; }
                props.onOpenStep(id);
              }}
              onKeyDown={(event) => {
                if (props.onRenameStep && event.key === 'F2') { event.preventDefault(); setRenamingStep(id); return; }
                if (!selectable) return;
                const mod = event.metaKey || event.ctrlKey;
                if (event.key === ' ' && (mod || event.shiftKey)) { event.preventDefault(); if (mod) toggle(id); else selectRange(id); return; }
                if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') { event.preventDefault(); anchor.current = scene.stepIds[0] ?? null; setSelection([...scene.stepIds]); return; }
              }}
            />
          );
          if (!props.onRenameStep && !selectable) return frame;
          const rename = props.onRenameStep;
          // With a selection, a selected card's button adds all of it; otherwise it adds its own step.
          const adds = isSelected && selected.length > 1 ? selected : [id];
          const others = adds.length - 1;
          const addLabel = others ? `Add step ${at + 1} and the ${others === 1 ? 'other selected step' : `${others} other selected steps`} to chat` : `Add step ${at + 1} to chat`;
          // The card opens the step; its title, on top of the card's label, names it.
          return (
            <div key={id} className="step-card" data-renaming={renamingStep === id || undefined} data-selected={isSelected || undefined} data-framed={state.steps[id]?.framed ? true : undefined}>
              {frame}
              {selectable && renamingStep !== id && (
                <button
                  type="button" className="step-card__chat" tabIndex={last === at ? 0 : -1} aria-label={addLabel}
                  title={adds.length > 1 ? `Add ${adds.length} steps to chat` : 'Add to chat'}
                  onFocus={() => setActive(at)} onClick={() => addToChat(adds)}
                >
                  <MessageSquarePlus className="i" aria-hidden="true" />
                </button>
              )}
              {!rename ? null : renamingStep === id ? (
                <div className="step-card__rename">
                  <NameField
                    initial={title ?? ''}
                    placeholder="Untitled"
                    label={`Title of step ${at + 1}`}
                    onSave={async (next) => { await rename(id, next); endStepRename(at); }}
                    onCancel={() => endStepRename(at)}
                    onAbandon={(message) => { endStepRename(at); props.onRenameAbandon(message); }}
                  />
                </div>
              ) : (
                <button type="button" className="step-card__title" tabIndex={-1} title="Change the title" aria-label={`Change the title of step ${at + 1}`} onClick={() => setRenamingStep(id)}>
                  <Pencil className="i" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        <button
          ref={(element) => { items.current[count] = element; }}
          type="button"
          className={`frame-add${count === 0 ? ' frame-add--empty' : ''}`}
          aria-label={`Add step to scene ${index + 1}`}
          tabIndex={last === count ? 0 : -1}
          disabled={adding}
          onFocus={() => setActive(count)}
          onClick={() => void add()}
        >
          <span className="frame-add__icon"><Plus className="i" aria-hidden="true" /></span>
          <span className="frame-add__text">{count === 0 ? 'Add the first step' : 'The next step'}</span>
          <span className="frame-add__sub">Add a step to this scene</span>
        </button>
      </div>

      {menu && (
        <ActionMenu
          anchor={menu}
          label={`Actions for scene ${index + 1}`}
          onClose={() => setMenu(null)}
          actions={[
            { label: 'Add step', icon: <Plus className="i" aria-hidden="true" />, onSelect: () => void add() },
            { label: 'Rename', icon: <Pencil className="i" aria-hidden="true" />, onSelect: props.onRenameStart },
            { label: 'Move up', icon: <ArrowUp className="i" aria-hidden="true" />, disabled: index === 0, onSelect: () => props.onMove(-1) },
            { label: 'Move down', icon: <ArrowDown className="i" aria-hidden="true" />, disabled: index === total - 1, onSelect: () => props.onMove(1) },
            { label: 'Delete…', icon: <Trash2 className="i" aria-hidden="true" />, danger: true, onSelect: props.onDelete },
          ]}
        />
      )}
    </section>
  );
}
