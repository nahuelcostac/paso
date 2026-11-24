import { useEffect, useRef } from 'react';
import { Clapperboard, Presentation } from 'lucide-react';
import type { View } from '../lib/route';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The views' shortcuts: Ctrl+Alt (⌘⌥ on macOS) with 1 or 2, by the key's place, so any layout has them. Excalidraw uses
 * neither Alt with a digit nor Ctrl/Cmd+Alt with one, and the browsers keep Ctrl/Cmd+digit and, on Linux, Alt+digit
 * for their tabs, which these leave alone.
 */
export const VIEW_SHORTCUTS: Record<View, { code: string; label: string; aria: string }> = {
  canvas: { code: 'Digit1', label: mac ? '⌘⌥1' : 'Ctrl+Alt+1', aria: mac ? 'Meta+Alt+1' : 'Control+Alt+1' },
  storyboard: { code: 'Digit2', label: mac ? '⌘⌥2' : 'Ctrl+Alt+2', aria: mac ? 'Meta+Alt+2' : 'Control+Alt+2' },
};

/** The view a key press asks for, or undefined. Not while typing: there the keys may write a character. */
export function viewShortcut(event: KeyboardEvent): View | undefined {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || !event.altKey || event.shiftKey || event.repeat) return undefined;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], .present')) return undefined;
  return (Object.keys(VIEW_SHORTCUTS) as View[]).find((view) => VIEW_SHORTCUTS[view].code === event.code);
}

const VIEWS: Array<{ view: View; label: string; Icon: typeof Presentation }> = [
  { view: 'canvas', label: 'Diagram', Icon: Presentation },
  { view: 'storyboard', label: 'Studio', Icon: Clapperboard },
];

/** Set when the switch changes the view, so the switch of the view that replaces it takes the focus. */
let refocus = false;

/**
 * Diagram | Studio, in the top right corner of both views, left of Present. It changes the view only: what the sidebar
 * shows stays as it is. Each view mounts its own copy, so the focus is carried over to the new one.
 */
export function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus) return;
    refocus = false;
    current.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="view-switch" role="group" aria-label="View">
      {VIEWS.map(({ view: id, label, Icon }) => (
        <button
          key={id} ref={id === view ? current : undefined} type="button" className="view-switch__option"
          aria-pressed={id === view} aria-label={label} aria-keyshortcuts={VIEW_SHORTCUTS[id].aria}
          title={`${label} (${VIEW_SHORTCUTS[id].label})`}
          onClick={() => {
            if (id === view) return;
            refocus = true;
            onChange(id);
          }}
        >
          <Icon className="i" aria-hidden="true" /><span className="view-switch__label">{label}</span>
        </button>
      ))}
    </div>
  );
}
