import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  anchor: HTMLElement;
  onClose: () => void;
  /** Where the popover lines up with its anchor. */
  align?: 'start' | 'end';
  role: 'dialog' | 'menu';
  label: string;
  className?: string;
  children: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * A raised glass surface mounted on the body. Glass does not nest, so a popover must live outside
 * the blurred panel that opened it. Escape and a press outside close it and return focus to the anchor.
 */
export function Popover({ anchor, onClose, align = 'start', role, label, className = '', children, onKeyDown }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const margin = 8;
      const left = align === 'end' ? a.right - width : a.left;
      let top = a.bottom + 6;
      if (top + height > window.innerHeight - margin) top = Math.max(margin, a.top - height - 6);
      setPosition({ left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)), top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, align]);

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
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
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
