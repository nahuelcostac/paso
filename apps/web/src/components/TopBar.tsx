import { PanelLeft } from 'lucide-react';
import type { View } from '../lib/route';
import { Brand } from './Brand';
import { ViewSelector } from './ViewSelector';
import { pad } from './StepFrame';

type Props = {
  saveNotice?: React.ReactNode;
  /** The scene switcher, on the Lienzo only. It opens the bar's second row. */
  sceneSelector?: React.ReactNode;
  /** The open step on the Lienzo: its position in the scene, from 1, and its optional title. */
  step?: { number: number; title?: string };
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
              {step.title && <span className="topbar__step-title" title={step.title}>{step.title}</span>}
            </p>
          )}
        </div>
      )}
    </header>
  );
}
