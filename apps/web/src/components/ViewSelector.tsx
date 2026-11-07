import { useRef, type KeyboardEvent } from 'react';
import type { View } from '../lib/route';

const OPTIONS: Array<{ view: View; label: string }> = [
  { view: 'storyboard', label: 'Storyboard' },
  { view: 'lienzo', label: 'Lienzo' },
];

/** A radio group: one tab stop, arrow keys move and select, the selected option is an inverted pill. */
export function ViewSelector({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent) => {
    const at = OPTIONS.findIndex((option) => option.view === view);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % OPTIONS.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at - 1 + OPTIONS.length) % OPTIONS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? OPTIONS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(OPTIONS[next].view);
    buttons.current[next]?.focus();
  };
  return (
    <div className="selector glass" role="radiogroup" aria-label="Vista" onKeyDown={onKeyDown}>
      {OPTIONS.map(({ view: value, label }, index) => (
        <button
          key={value}
          ref={(element) => { buttons.current[index] = element; }}
          type="button"
          role="radio"
          aria-checked={value === view}
          tabIndex={value === view ? 0 : -1}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
