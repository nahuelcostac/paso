import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Clapperboard, Presentation, Settings } from 'lucide-react';
import { Brand } from './Brand';
import { SettingsMenu } from './SettingsMenu';
import { useCanvasMenu, type CanvasMenu } from '../editor/canvas-menu';
import type { View } from '../lib/route';

type Props = {
  chatOpen: boolean;
  /** The agent works while its panel is out of view: a pink dot on Studio. */
  working?: boolean;
  /** The current view, or undefined when no diagram is open. */
  view?: View;
  onDiagram: () => void;
  onStudio: () => void;
  canvasMenu: CanvasMenu;
  /** The workspace switcher, given the footer toolbar's tab stop for it. */
  workspace: (stop: { tabIndex: number; onFocus: () => void }) => ReactNode;
  children: ReactNode;
};

export function Sidebar({ chatOpen, working = false, view, onDiagram, onStudio, canvasMenu, workspace, children }: Props) {
  const gear = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canvas = useCanvasMenu(canvasMenu);
  const [viewStop, setViewStop] = useState('diagram');
  const [toolStop, setToolStop] = useState('workspace');
  const studioTitle = view === 'canvas' ? 'Open Studio with agent chat' : chatOpen ? 'Studio' : 'Open agent chat';

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 'first', End: 'last' };
    const to = keys[event.key];
    if (to === undefined || !(event.target instanceof HTMLElement) || !event.target.matches('.sidebar__button')) return;
    event.preventDefault();
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>('.sidebar__button')];
    const from = all.indexOf(event.target);
    const next = all[to === 'first' ? 0 : to === 'last' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, from + to))];
    next?.focus();
  };

  const button = (id: string, label: string, icon: ReactNode, state: Record<string, unknown>, onClick: () => void, extra?: ReactNode, title = label) => {
    return (
      <button
        type="button" className="sidebar__button" data-id={id} aria-label={label} title={title} tabIndex={id === viewStop ? 0 : -1}
        onFocus={() => setViewStop(id)} onClick={onClick} {...state}
      >
        {icon}{extra}
      </button>
    );
  };

  return (
    <div className="sidebar">
      <div className="panel-brand"><Brand /></div>
      <div className="sidebar__body">
        {view && <div className="sidebar__views" role="toolbar" aria-orientation="horizontal" aria-label="View controls" onKeyDown={onKeyDown}>
          {button('diagram', 'Diagram', <Presentation className="i" aria-hidden="true" />,
            { 'aria-pressed': view === 'canvas' }, onDiagram)}
          {button('studio', 'Studio', <Clapperboard className="i" aria-hidden="true" />,
            {
              'aria-pressed': view === 'storyboard',
              'aria-expanded': chatOpen,
              'aria-controls': chatOpen ? 'agent-panel' : undefined,
            }, onStudio,
            working ? <span className="sidebar__badge" aria-hidden="true" /> : undefined,
            studioTitle)}
        </div>}
        {children}
        <div className="sidebar__tools" role="toolbar" aria-orientation="horizontal" aria-label="Workspace controls" onKeyDown={onKeyDown}>
          {workspace({ tabIndex: toolStop === 'workspace' ? 0 : -1, onFocus: () => setToolStop('workspace') })}
          <button
            ref={gear} type="button" className="sidebar__button" data-id="settings" aria-label="Settings" title="Settings"
            aria-haspopup="menu" aria-expanded={menuOpen} tabIndex={toolStop === 'settings' ? 0 : -1}
            onFocus={() => setToolStop('settings')} onClick={() => setMenuOpen(!menuOpen)}
          >
            <Settings className="i" aria-hidden="true" />
          </button>
        </div>
      </div>
      {menuOpen && gear.current && <SettingsMenu anchor={gear.current} canvas={canvas} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
