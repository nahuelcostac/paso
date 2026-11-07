import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Ellipsis, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { useGridColumns, useNear } from '../lib/dom-hooks';
import { formatSteps } from '../lib/format';
import type { Theme, ThumbnailCache } from '../editor/thumbnails';
import { sceneKey, type SceneEntry, type StoryboardState, type StoryboardStore } from '../state/storyboard-store';
import { useSceneThumbnails } from '../state/use-scene-thumbnails';
import { ActionMenu } from './ActionMenu';
import { NameField } from './NameField';
import { pad, StepFrame } from './StepFrame';

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
  registerGrip: (element: HTMLButtonElement | null) => void;
};

/** One scene: number, title and step count on a line, then its steps as a grid of numbered frames. */
export function SceneSection(props: Props) {
  const { scene, index, total, state, store, api, cache, theme, root, currentStepId, renaming, grabbed, dragging, dropMarker } = props;
  const section = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);

  const near = useNear(section, root);
  useEffect(() => { if (near) store.ensureSteps(scene.id); }, [near, store, scene.id]);
  const { thumbnails } = useSceneThumbnails({ api, cache, projectId: store.projectId, sceneId: scene.id, theme, key: sceneKey(state, scene), enabled: near });

  const count = scene.stepIds.length;
  const columns = useGridColumns(grid);
  // A full last row would send the add slot onto a row of its own and push the next scene down on hover. It hangs in the gap instead.
  const tail = count > 0 && count % columns === 0;
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
    const end = count; // index of the add slot
    const target: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + columns, ArrowUp: at - columns, Home: 0, End: end };
    if (!(event.key in target)) return;
    event.preventDefault();
    let next = target[event.key];
    if (next > end) next = event.key === 'ArrowDown' && at < end ? end : at;
    if (next < 0) next = at;
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
      aria-label={`Escena ${index + 1}: ${name}`}
      data-scene-id={scene.id}
      data-grabbed={grabbed || undefined}
      data-dragging={dragging || undefined}
      data-drop={dropMarker}
    >
      <div className="scene__head">
        <span className="scene__num">{pad(index + 1)}</span>
        {renaming ? (
          <div className="scene__rename">
            <NameField initial={name} label={`Nombre de la escena ${index + 1}`} onSave={props.onRename} onCancel={props.onRenameEnd} onAbandon={props.onRenameAbandon} />
          </div>
        ) : <h2 className="scene__title">{name}</h2>}
        <span className="scene__meta">{formatSteps(count)}</span>
        {!renaming && (
          <span className="scene__tools">
            <button
              ref={props.registerGrip}
              type="button"
              className="scene__tool scene__grip"
              aria-label={`Reordenar la escena ${index + 1}, ${name}`}
              aria-pressed={grabbed}
              title="Arrastra, o pulsa Intro y usa las flechas"
              onKeyDown={props.onGripKeyDown}
              onBlur={props.onGripBlur}
              onPointerDown={props.onGripPointerDown}
              onPointerMove={props.onGripPointerMove}
              onPointerUp={props.onGripPointerEnd}
              onPointerCancel={props.onGripPointerEnd}
            >
              <GripVertical className="i" aria-hidden="true" />
            </button>
            <button ref={more} type="button" className="scene__tool" aria-haspopup="menu" aria-expanded={menu !== null} aria-label={`Más acciones de la escena ${index + 1}, ${name}`} onClick={() => setMenu(menu ? null : more.current)}>
              <Ellipsis className="i" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      <div ref={grid} className="scene__steps" role="group" aria-label={`Pasos de ${name}`} onKeyDown={move}>
        {scene.stepIds.map((id, at) => (
          <StepFrame
            key={id}
            ref={(element) => { items.current[at] = element; }}
            number={at + 1}
            title={state.steps[id]?.title}
            current={id === currentStepId}
            svg={thumbnails?.[id]?.svg}
            tabIndex={last === at ? 0 : -1}
            onFocus={() => setActive(at)}
            onClick={() => props.onOpenStep(id)}
          />
        ))}
        <button
          ref={(element) => { items.current[count] = element; }}
          type="button"
          className={`frame-add${tail ? ' frame-add--tail' : ''}${count === 0 ? ' frame-add--empty' : ''}`}
          aria-label={`Añadir paso a la escena ${index + 1}`}
          tabIndex={last === count ? 0 : -1}
          disabled={adding}
          onFocus={() => setActive(count)}
          onClick={() => void add()}
        >
          <Plus className="i" aria-hidden="true" />
          {count === 0 && <span className="frame-add__text">Añadir el primer paso</span>}
        </button>
      </div>

      {menu && (
        <ActionMenu
          anchor={menu}
          label={`Acciones de la escena ${index + 1}`}
          onClose={() => setMenu(null)}
          actions={[
            { label: 'Añadir paso', icon: <Plus className="i" aria-hidden="true" />, onSelect: () => void add() },
            { label: 'Renombrar', icon: <Pencil className="i" aria-hidden="true" />, onSelect: props.onRenameStart },
            { label: 'Mover arriba', icon: <ArrowUp className="i" aria-hidden="true" />, disabled: index === 0, onSelect: () => props.onMove(-1) },
            { label: 'Mover abajo', icon: <ArrowDown className="i" aria-hidden="true" />, disabled: index === total - 1, onSelect: () => props.onMove(1) },
            { label: 'Eliminar…', icon: <Trash2 className="i" aria-hidden="true" />, danger: true, onSelect: props.onDelete },
          ]}
        />
      )}
    </section>
  );
}
