import { PanelLeft } from 'lucide-react';
import type { View } from '../lib/route';
import { ViewSelector } from './ViewSelector';

type Props = { saveNotice?: React.ReactNode; view: View; onViewChange: (view: View) => void; panelOpen: boolean; onTogglePanel: () => void };

/**
 * Three columns with equal outer ones, so the selector sits on the window's true centre in both views.
 * The right column is kept for the agent status and Presentar.
 */
export function TopBar({ view, onViewChange, panelOpen, onTogglePanel, saveNotice }: Props) {
  return (
    <header className="topbar">
      <div className="topbar__side">
        <div className="brand">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 14.5h4v-4h4.5V6h4.5V1.5" /></svg>
          paso
        </div>
        <button type="button" className="icon-btn" aria-label={panelOpen ? 'Ocultar proyectos' : 'Mostrar proyectos'} aria-expanded={panelOpen} onClick={onTogglePanel}>
          <PanelLeft className="i" aria-hidden="true" />
        </button>
      </div>
      <ViewSelector view={view} onChange={onViewChange} />
      <div className="topbar__side topbar__side--end">{saveNotice}</div>
    </header>
  );
}
