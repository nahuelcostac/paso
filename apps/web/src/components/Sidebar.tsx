import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Folders, MessageSquare, Settings } from 'lucide-react';
import { Brand } from './Brand';
import { SettingsMenu } from './SettingsMenu';
import { useCanvasMenu, type CanvasMenu } from '../editor/canvas-menu';

export type SidePanel = 'projects' | 'agent';

type Props = {
  /** The panel shown under the panel buttons. */
  panel: SidePanel;
  /** The agent's chat needs an open diagram. Without one its button stays, disabled, saying why. */
  agentAvailable: boolean;
  /** The agent works while its panel is out of view: a pink dot on its button. */
  working?: boolean;
  /** A panel's button: the other panel opens; the open one folds the sidebar. */
  onPanel: (panel: SidePanel) => void;
  canvasMenu: CanvasMenu;
  /** The workspace switcher, given the footer toolbar's tab stop for it. */
  workspace: (stop: { tabIndex: number; onFocus: () => void }) => ReactNode;
  children: ReactNode;
};

/**
 * The sidebar, as VS Code's activity bar: its top row chooses the panel (Projects or the agent's chat), its foot holds the
 * workspace and the gear. It never changes the view, which the switch in the main view's corner chooses.
 */
export function Sidebar({ panel, agentAvailable, working = false, onPanel, canvasMenu, workspace, children }: Props) {
  const gear = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canvas = useCanvasMenu(canvasMenu);
  const [panelStop, setPanelStop] = useState<SidePanel>(panel);
  const [toolStop, setToolStop] = useState('workspace');

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

  const button = (id: SidePanel, label: string, icon: ReactNode, { title, disabled = false, extra }: { title: string; disabled?: boolean; extra?: ReactNode }) => {
    const open = id === panel;
    return (
      <button
        type="button" className="sidebar__button" data-id={id} aria-label={label} title={title} tabIndex={id === panelStop ? 0 : -1}
        aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} aria-disabled={disabled || undefined}
        onFocus={() => setPanelStop(id)} onClick={() => { if (!disabled) onPanel(id); }}
      >
        {icon}{extra}
      </button>
    );
  };

  return (
    <div className="sidebar">
      <div className="panel-brand"><Brand /></div>
      <div className="sidebar__body">
        <div className="sidebar__panels" role="toolbar" aria-orientation="horizontal" aria-label="Sidebar panels" onKeyDown={onKeyDown}>
          {button('projects', 'Projects', <Folders className="i" aria-hidden="true" />,
            { title: panel === 'projects' ? 'Hide projects' : 'Projects' })}
          {button('agent', 'Agent', <MessageSquare className="i" aria-hidden="true" />, {
            title: !agentAvailable ? 'Open a diagram to chat with its agent' : panel === 'agent' ? 'Hide agent' : working ? 'Agent (working)' : 'Agent',
            disabled: !agentAvailable,
            extra: working ? <span className="sidebar__badge" aria-hidden="true" /> : undefined,
          })}
        </div>
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
