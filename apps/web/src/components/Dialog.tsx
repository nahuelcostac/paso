import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  title: string; onClose: () => void; children: ReactNode;
  /** A confirmation is an alertdialog. A dialog to work in, such as the folder explorer, is a plain dialog. */
  role?: 'alertdialog' | 'dialog';
  className?: string;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A confirmation. It traps focus, closes on Escape or a press on the scrim, and gives focus back when it closes. */
export function Dialog({ title, onClose, children, role = 'alertdialog', className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The safe choice is focused first, so Enter never confirms a deletion by accident.
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  return createPortal(
    <div className="scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog ${className}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
          if (event.key !== 'Tab') return;
          const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <h2 id={titleId} className="dialog__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
