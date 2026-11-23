import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Keyboard for a menu inside a popover: on open the checked item, or the first, takes focus; arrow keys,
 * Home and End move. Items marked `aria-disabled` can be reached, so their reason can be read, but not used.
 * A menu of options rather than one choice (`start: 'first'`) opens on its first item whatever is checked.
 */
export function useMenuKeys(list: RefObject<HTMLElement | null>, start: 'checked' | 'first' = 'checked') {
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])];
  // Once, on open. The popover is placed before effects run, so its items can take focus here.
  useEffect(() => {
    const all = items();
    ((start === 'checked' ? all.find((item) => item.getAttribute('aria-checked') === 'true') : undefined) ?? all[0])?.focus();
  }, []);
  return (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const all = items();
    const from = all.indexOf(document.activeElement as HTMLElement);
    all[to === 'first' ? 0 : to === 'last' ? all.length - 1 : (from + to + all.length) % all.length]?.focus();
  };
}

type Props = {
  anchor: HTMLElement;
  onClose: () => void;
  /** Where the popover lines up with its anchor. */
  align?: 'start' | 'end';
  /** Under the anchor (or above it, without room), or beside it on its right, ending level with its foot. */
  side?: 'below' | 'right';
  role: 'dialog' | 'menu';
  label: string;
  className?: string;
  children: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * A raised surface mounted on the body, so no panel's overflow or stacking can clip it.
 * Escape and a press outside close it and return focus to the anchor.
 */
export function Popover({ anchor, onClose, align = 'start', side = 'below', role, label, className = '', children, onKeyDown }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Placed straight on the element, before paint and before any effect: a menu that focuses its first item
  // in an effect finds it visible and in place. Hiding it until a re-render made that focus fail.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const margin = 8;
      let left = align === 'end' ? a.right - width : a.left;
      let top = a.bottom + 6;
      if (side === 'right') { left = a.right + margin; top = Math.max(margin, a.bottom - height); }
      else if (top + height > window.innerHeight - margin) top = Math.max(margin, a.top - height - 6);
      const clampedLeft = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
      element.style.left = `${clampedLeft}px`;
      element.style.top = `${top}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, align, side]);

  useEffect(() => {
    const press = (event: PointerEvent) => {
      const target = event.target as Node;
      // The anchor toggles the popover itself, so a press on it is not "outside".
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [anchor, onClose]);

  const close = (restoreFocus: boolean) => { onClose(); if (restoreFocus) anchor.focus(); };

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={`popover ${className}`}
      style={{ left: 0, top: 0 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
        if (event.key === 'Tab' && role === 'menu') { close(false); return; }
        onKeyDown?.(event);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
