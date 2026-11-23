import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Folders, LayoutGrid, MessageCircle, Settings } from 'lucide-react';
import { SettingsMenu } from './SettingsMenu';
import { useCanvasMenu, type CanvasMenu } from '../editor/canvas-menu';

export type SidePanel = 'projects' | 'agent';

type Props = {
  /** The panel in view in the left spot, if any. */
  panel: SidePanel | null;
  onPanel: (panel: SidePanel) => void;
  /**
   * Where the chat is: beside this view (`here`), in the Studio of this project, which the button opens (`studio`), or
   * nowhere, with no project open (`none`, no button).
   */
  chat: 'here' | 'studio' | 'none';
  /** The agent works while its panel is out of view: a pink dot on its button. */
  working?: boolean;
  /** Whether the Studio is the view on screen; undefined when there is no Studio (a plain whiteboard, no project). */
  studio?: boolean;
  onStudio: () => void;
  canvasMenu: CanvasMenu;
};

/**
 * The black bar down the window's left edge, as in VS Code: at the top, the two panels that share the left spot and the
 * Studio; at the foot, the gear with what Excalidraw's main menu held. It is one toolbar: Tab reaches it once, and the
 * arrow keys, Home and End move between its buttons.
 */
export function ActivityBar({ panel, onPanel, chat, working = false, studio, onStudio, canvasMenu }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canvas = useCanvasMenu(canvasMenu);
  // The button that keeps the toolbar's one tab stop: the last one used.
  const [current, setCurrent] = useState('projects');
  const shown = ['projects', ...(chat === 'none' ? [] : ['agent']), ...(studio === undefined ? [] : ['studio']), 'settings'];
  const stop = shown.includes(current) ? current : 'projects';

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
      <div className="activity-bar__group">
        {button('projects', 'Projects', <Folders className="i" aria-hidden="true" />,
          { 'aria-expanded': panel === 'projects', 'aria-controls': panel === 'projects' ? 'projects-panel' : undefined },
          () => onPanel('projects'))}
        {chat !== 'none' && button('agent', 'Agent chat', <MessageCircle className="i" aria-hidden="true" />,
          { 'aria-expanded': panel === 'agent', 'aria-controls': panel === 'agent' ? 'agent-panel' : undefined },
          () => onPanel('agent'),
          working && panel !== 'agent' ? <span className="activity-bar__badge" aria-hidden="true" /> : undefined,
          chat === 'studio' ? 'Agent chat, in the Studio' : 'Agent chat')}
        {studio !== undefined && button('studio', 'Studio', <LayoutGrid className="i" aria-hidden="true" />,
          { 'aria-pressed': studio }, onStudio, undefined, studio ? 'Studio: back to the Canvas' : "Studio: the scene's steps")}
      </div>
      <div className="activity-bar__group">
        <button
          ref={gear} type="button" className="activity-bar__button" data-id="settings" aria-label="Settings" title="Settings"
          aria-haspopup="menu" aria-expanded={menuOpen} tabIndex={stop === 'settings' ? 0 : -1}
          onFocus={() => setCurrent('settings')} onClick={() => setMenuOpen(!menuOpen)}
        >
          <Settings className="i" aria-hidden="true" />
        </button>
      </div>
      {menuOpen && gear.current && <SettingsMenu anchor={gear.current} canvas={canvas} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
