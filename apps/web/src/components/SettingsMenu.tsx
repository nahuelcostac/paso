import { useId, useRef, type ReactNode } from 'react';
import { Check, Eye, Focus, Grid3x3, ImageDown, Library, Monitor, Moon, Pipette, Sun } from 'lucide-react';
import { Popover, useMenuKeys } from './Popover';
import { chooseTheme, useThemeChoice, type ThemeChoice } from '../lib/theme';
import { CANVAS_BACKGROUNDS, type CanvasMenuHandle } from '../editor/canvas-menu';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const THEMES: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun }, { value: 'dark', label: 'Dark', Icon: Moon }, { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * The gear's menu, at the foot of the activity bar: everything Excalidraw's main menu held. The canvas options act on the
 * Canvas's drawing, so without one on screen (the Studio, a step still loading) they stay in place, greyed, and a note
 * says where they work; the theme works everywhere.
 */
export function SettingsMenu({ anchor, onClose, canvas }: { anchor: HTMLElement; onClose: () => void; canvas: CanvasMenuHandle | undefined }) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = useMenuKeys(list, 'first');
  const noteId = useId();
  const custom = useRef<HTMLInputElement>(null);
  const theme = useThemeChoice();
  const off = canvas ? {} : { 'aria-disabled': true, 'aria-describedby': noteId } as const;
  /** Runs a canvas action, then closes, as Excalidraw's menu did. Checks and colours keep the menu open. */
  const act = (run: (handle: CanvasMenuHandle) => void, close = true) => () => {
    if (!canvas) return;
    run(canvas);
    if (close) onClose();
  };

  // A render helper, not a component: a component made here would be a new type on every render, and the item with
  // focus would be replaced when a check changes.
  // Excalidraw's own shortcut shows on the right, and is announced as the item's shortcut rather than read in its name.
  const item = ({ icon, label, shortcut, onSelect, checked }: { icon: ReactNode; label: string; shortcut?: [string, string]; onSelect: () => void; checked?: boolean }) => (
    <button
      type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} aria-label={label}
      aria-keyshortcuts={shortcut?.[1]} {...off} onClick={onSelect} className="settings-menu__item"
    >
      <span className="menu__check" aria-hidden="true">{checked ? <Check className="i" /> : icon}</span>
      <span className="menu__label">{label}</span>
      {shortcut && <span className="menu__meta" aria-hidden="true">{shortcut[0]}</span>}
    </button>
  );

  return (
    <Popover anchor={anchor} side="right" onClose={onClose} role="menu" label="Settings" className="menu settings-menu" onKeyDown={onKeyDown}>
      <div ref={list}>
        {!canvas && <p className="settings-menu__note" id={noteId}>Open a step on the Canvas to use the drawing options.</p>}
        {item({ icon: <ImageDown className="i" />, label: 'Export image…', onSelect: act((handle) => handle.exportImage()) })}
        <hr />
        <div role="group" aria-labelledby={`${noteId}-preferences`}>
          <p className="settings-menu__heading" id={`${noteId}-preferences`}>Preferences</p>
          {item({ icon: <Grid3x3 className="i" />, label: 'Show grid', shortcut: mac ? ["Cmd+'", "Meta+'"] : ["Ctrl+'", "Control+'"], checked: canvas?.modes.grid ?? false, onSelect: act((handle) => handle.toggle('grid'), false) })}
          {item({ icon: <Focus className="i" />, label: 'Zen mode', shortcut: ['Alt+Z', 'Alt+Z'], checked: canvas?.modes.zen ?? false, onSelect: act((handle) => handle.toggle('zen'), false) })}
          {item({ icon: <Eye className="i" />, label: 'View mode', shortcut: ['Alt+R', 'Alt+R'], checked: canvas?.modes.view ?? false, onSelect: act((handle) => handle.toggle('view'), false) })}
          {/* Light, Dark and System, for the whole window: the Studio follows it too, so it is never greyed. */}
          <div className="settings-menu__row">
            <span className="settings-menu__row-label" id={`${noteId}-theme`}>Theme</span>
            <div className="settings-menu__choices" role="group" aria-labelledby={`${noteId}-theme`}>
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value} type="button" role="menuitemradio" aria-checked={theme === value} aria-label={`${label} theme`} title={label}
                  className="settings-menu__choice" onClick={() => chooseTheme(value)}
                >
                  <Icon className="i" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <hr />
        {item({ icon: <Library className="i" />, label: 'Library', onSelect: act((handle) => handle.toggleLibrary()) })}
        {/* Excalidraw's first canvas colours, then any other. In the dark theme they show as the canvas shows them. */}
        <div className="settings-menu__row">
          <span className="settings-menu__row-label" id={`${noteId}-background`}>Canvas background</span>
        </div>
        <div className="settings-menu__choices settings-menu__swatches" role="group" aria-labelledby={`${noteId}-background`}>
          {CANVAS_BACKGROUNDS.map(({ color, name }) => (
            <button
              key={color} type="button" role="menuitemradio" aria-checked={canvas?.background.toLowerCase() === color} aria-label={name} title={`${name} ${color}`}
              className="settings-menu__choice settings-menu__swatch" {...off} onClick={act((handle) => handle.setBackground(color), false)}
            >
              <span style={{ background: color }} aria-hidden="true" />
            </button>
          ))}
          <button
            type="button" role="menuitem" aria-label="Other colour…" title="Other colour…" className="settings-menu__choice" {...off}
            onClick={act(() => { const input = custom.current; if (!input) return; try { input.showPicker(); } catch { input.click(); } }, false)}
          >
            <Pipette className="i" aria-hidden="true" />
          </button>
          <input
            ref={custom} type="color" className="visually-hidden" tabIndex={-1} aria-hidden="true"
            value={/^#[0-9a-f]{6}$/i.test(canvas?.background ?? '') ? canvas!.background : '#ffffff'}
            onChange={(event) => canvas?.setBackground(event.target.value)}
          />
        </div>
      </div>
    </Popover>
  );
}
