import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Clapperboard, Ellipsis, Settings } from 'lucide-react';
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
  /** The workspace switcher, above the gear, given the toolbar's tab stop for it. */
  workspace: (stop: { tabIndex: number; onFocus: () => void }) => ReactNode;
};

/**
 * Diagram and Studio sit above the workspace switcher and settings. Tab reaches the toolbar once.
 * The arrow keys, Home and End move between its buttons.
 */
export function ActivityBar({ chatOpen, working = false, view, onDiagram, onStudio, canvasMenu, workspace }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canvas = useCanvasMenu(canvasMenu);
  // The button that keeps the toolbar's one tab stop: the last one used.
  const [current, setCurrent] = useState<string>();
  const shown = [...(view ? ['diagram', 'studio'] : []), 'workspace', 'settings'];
  const stop = current && shown.includes(current) ? current : shown[0];
  const studioTitle = view === 'canvas' ? 'Open Studio with agent chat' : chatOpen ? 'Studio' : 'Open agent chat';

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
    const to = keys[event.key];
    if (to === undefined || !(event.target instanceof HTMLElement) || !event.target.matches('.activity-bar__button')) return;
    event.preventDefault();
    const all = [...(bar.current?.querySelectorAll<HTMLElement>('.activity-bar__button') ?? [])];
    const from = all.indexOf(event.target);
    const next = all[to === 'first' ? 0 : to === 'last' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, from + to))];
    next?.focus();
  };

  const button = (id: string, label: string, icon: ReactNode, state: Record<string, unknown>, onClick: () => void, extra?: ReactNode, title = label) => {
    return (
      <button
        type="button" className="activity-bar__button" data-id={id} aria-label={label} title={title} tabIndex={id === stop ? 0 : -1}
        onFocus={() => setCurrent(id)} onClick={onClick} {...state}
      >
        {icon}{extra}
      </button>
    );
  };

  return (
    <div ref={bar} className="activity-bar" role="toolbar" aria-orientation="vertical" aria-label="Activity bar" onKeyDown={onKeyDown}>
      <div className="activity-bar__buttons">
        <div className="activity-bar__group">
          {view && button('diagram', 'Diagram', <Ellipsis className="i" aria-hidden="true" />,
            { 'aria-pressed': view === 'canvas' }, onDiagram)}
          {view && button('studio', 'Studio', <Clapperboard className="i" aria-hidden="true" />,
            {
              'aria-pressed': view === 'storyboard',
              'aria-expanded': chatOpen,
              'aria-controls': chatOpen ? 'agent-panel' : undefined,
            }, onStudio,
            working ? <span className="activity-bar__badge" aria-hidden="true" /> : undefined,
            studioTitle)}
        </div>
        <div className="activity-bar__group">
          {workspace({ tabIndex: stop === 'workspace' ? 0 : -1, onFocus: () => setCurrent('workspace') })}
          <button
            ref={gear} type="button" className="activity-bar__button" data-id="settings" aria-label="Settings" title="Settings"
            aria-haspopup="menu" aria-expanded={menuOpen} tabIndex={stop === 'settings' ? 0 : -1}
            onFocus={() => setCurrent('settings')} onClick={() => setMenuOpen(!menuOpen)}
          >
            <Settings className="i" aria-hidden="true" />
          </button>
        </div>
      </div>
      {menuOpen && gear.current && <SettingsMenu anchor={gear.current} canvas={canvas} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
