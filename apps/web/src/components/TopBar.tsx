import { PanelLeft } from 'lucide-react';
import type { View } from '../lib/route';
import { ViewSelector } from './ViewSelector';

type Props = {
  saveNotice?: React.ReactNode;
  /** The scene switcher, on the Lienzo only. */
  sceneSelector?: React.ReactNode;
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
 * Three columns with equal outer ones, so the selector sits on the window's true centre in both views.
 * The right column is kept for the agent status and Presentar, which goes at its end. Without Presentar the
 * reserved slot holds its place, so nothing placed before it moves between views.
 */
export function TopBar({ view, onViewChange, panelOpen, onTogglePanel, saveNotice, sceneSelector, saveState, notice, agentStatus, agentToggle, presentar }: Props) {
  return (
    <header className="topbar">
      <div className="topbar__side">
        <div className={`brand${panelOpen ? '' : ' brand--compact'}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 14.5h4v-4h4.5V6h4.5V1.5" /></svg>
          paso
        </div>
        <button type="button" className="icon-btn" aria-label={panelOpen ? 'Ocultar proyectos' : 'Mostrar proyectos'} aria-expanded={panelOpen} onClick={onTogglePanel}>
          <PanelLeft className="i" aria-hidden="true" />
        </button>
        {sceneSelector}
        {saveState && saveState !== 'failed' && saveState !== 'conflict' && <span className="save-state" role="status" data-save-state={saveState}>{SAVE_LABELS[saveState]}</span>}
      </div>
      <ViewSelector view={view} onChange={onViewChange} />
      <div className="topbar__side topbar__side--end">
        {notice}
        {saveNotice}
        {agentStatus}
        {/* The Storyboard has no Presentar: on a narrow window the agent's toggle takes its room. */}
        {presentar ?? agentToggle ?? <div className="topbar__presentar-slot" data-slot="presentar" aria-hidden="true" />}
      </div>
    </header>
  );
}
