import { PanelLeft, PanelRight } from 'lucide-react';

/**
 * Shows and hides a side of the window, as in Notion: one ghost button with the side's panel icon, at one place on the
 * page whether the side shows or not, so it never moves under the pointer. The sidebar's sits at the top left, after
 * the window's own buttons in the desktop app; the chat's at the top right, in its head or its rail.
 */
export function PanelToggle({ side, open, onToggle, hide, show, controls }: {
  side: 'left' | 'right';
  open: boolean;
  onToggle: () => void;
  /** Its names: “Hide …” while the side is in view, “Show …” while it is folded. */
  hide: string;
  show: string;
  controls: string;
}) {
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <button
      type="button" className={`panel-toggle panel-toggle--${side}`} aria-label={open ? hide : show} title={open ? hide : show}
      aria-expanded={open} aria-controls={controls} onClick={onToggle}
    >
      <Icon className="i" aria-hidden="true" />
    </button>
  );
}
