import { useEffect, useRef, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import type { View } from '../lib/route';
import { Brand } from './Brand';
import { ViewSelector } from './ViewSelector';
import { pad } from './StepFrame';

type Props = {
  saveNotice?: React.ReactNode;
  /** The scene switcher, on the Lienzo only. It opens the bar's second row. */
  sceneSelector?: React.ReactNode;
  /** The open step on the Lienzo: its id, its position in the scene from 1, and its optional title.
   * With onRename, once the step has loaded, the title is a field the person types into. */
  step?: { id: string; number: number; title?: string; onRename?: (title: string) => void };
  /** The current step's save state, on the Lienzo only. Failures are told once, by the Lienzo's own notice. */
  saveState?: 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';
  /** A failed action that has no other place to be said. */
  notice?: React.ReactNode;
  /** Who is changing which step, with Detener, wherever the agent panel is not in view. */
  agentStatus?: React.ReactNode;
  /** Opens the agent panel as a drawer on a narrow Storyboard. */
  agentToggle?: React.ReactNode;
  /** Presentar, on the Lienzo only. Elsewhere its room stays reserved. */
  presentar?: React.ReactNode;
  view: View; onViewChange: (view: View) => void; panelOpen: boolean; onTogglePanel: () => void;
};
/**
 * The open step's title, typed in place. Enter or leaving the field keeps it, Escape puts the last one back, and an empty
 * field removes it. It is saved with the drawing, so «Guardado» covers it. A title the agent writes shows up here unless
 * the person is typing.
 */
function StepTitle({ title, onRename }: { title?: string; onRename: (title: string) => void }) {
  const [value, setValue] = useState(title ?? '');
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing) setValue(title ?? ''); }, [title, editing]);
  return (
    <input
      className="topbar__step-title topbar__step-input" value={value} maxLength={120} placeholder="Añade un título" aria-label="Título del paso"
      title={value || undefined} spellCheck
      onFocus={() => { cancelled.current = false; setEditing(true); }}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); }
      }}
      onBlur={() => {
        setEditing(false);
        if (cancelled.current) setValue(title ?? '');
        else onRename(value);
      }}
    />
  );
}

const SAVE_LABELS = { saved: 'Guardado', dirty: 'Cambios pendientes', saving: 'Guardando…' } as const;

/**
 * The window's header. Its first row is three columns with equal outer ones, so the selector sits on the window's
 * true centre in both views. The right column is kept for the save state, the agent status and Presentar, which goes
 * at its end. Without Presentar the reserved slot holds its place, so nothing placed before it moves between views.
 * On the Lienzo a second row holds the scene selector and the open step.
 */
export function TopBar({ view, onViewChange, panelOpen, onTogglePanel, saveNotice, sceneSelector, step, saveState, notice, agentStatus, agentToggle, presentar }: Props) {
  return (
    <header className={`topbar${sceneSelector ? ' topbar--sub' : ''}`}>
      <div className="topbar__main">
        <div className="topbar__side">
          <Brand />
          <span className="topbar__divider" aria-hidden="true" />
          <button type="button" className="icon-btn" aria-label={panelOpen ? 'Ocultar proyectos' : 'Mostrar proyectos'} aria-expanded={panelOpen} onClick={onTogglePanel}>
            <PanelLeft className="i" aria-hidden="true" />
          </button>
        </div>
        <ViewSelector view={view} onChange={onViewChange} />
        <div className="topbar__side topbar__side--end">
          {notice}
          {saveNotice}
          {saveState && saveState !== 'failed' && saveState !== 'conflict' && <span className="save-state" role="status" data-save-state={saveState}>{SAVE_LABELS[saveState]}</span>}
          {agentStatus}
          {/* The Storyboard has no Presentar: on a narrow window the agent's toggle takes its room. */}
          {presentar ?? agentToggle ?? <div className="topbar__presentar-slot" data-slot="presentar" aria-hidden="true" />}
        </div>
      </div>
      {sceneSelector && (
        <div className="topbar__sub">
          {sceneSelector}
          {step && (
            <p className="topbar__step">
              <span className="eyebrow">Paso {pad(step.number)}</span>
              {step.onRename ? <StepTitle key={step.id} title={step.title} onRename={step.onRename} />
                : step.title && <span className="topbar__step-title" title={step.title}>{step.title}</span>}
            </p>
          )}
        </div>
      )}
    </header>
  );
}
