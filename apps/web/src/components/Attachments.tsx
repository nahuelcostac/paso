import { useEffect, useState } from 'react';
import { ImageOff, X } from 'lucide-react';

/**
 * One chip of an attachments row: what goes with a message, in the composer and in the conversation. Only images exist
 * today; another kind (such as a Studio step) adds its own `kind` and how it looks, and keeps the row, its order and
 * its remove button.
 */
export type AttachmentItem = {
  key: string;
  kind: 'image';
  /** What the chip is called, for its title and for screen readers: an image's file name. */
  label: string;
  /** An image's picture. Absent while it loads; `failed` when it couldn't be read. */
  src?: string;
  failed?: boolean;
};

/** A row of attachments. With `onRemove` each chip has an × to take it off the message. */
export function AttachmentRow({ items, label, onRemove, className }: {
  items: AttachmentItem[]; label: string; onRemove?: (key: string) => void; className?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className={`attachments${className ? ` ${className}` : ''}`} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={`attachment attachment--${item.kind}`} title={item.label}>
          {item.src ? <img src={item.src} alt={item.label} draggable={false} />
            : <span className="attachment__empty" role="img" aria-label={item.failed ? `${item.label} (couldn't be loaded)` : item.label}>
              {item.failed && <ImageOff className="i" aria-hidden="true" />}
            </span>}
          {onRemove && (
            <button type="button" className="attachment__remove" aria-label={`Remove ${item.label}`} title="Remove" onClick={() => onRemove(item.key)}>
              <X className="i" aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Resolves pictures that are read on demand, such as the images of a conversation the service keeps. */
export function useResolved(keys: string[], resolve: (key: string) => Promise<string>) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const joined = keys.join('\n');
  useEffect(() => {
    let live = true;
    for (const key of joined ? joined.split('\n') : []) {
      resolve(key).then((url) => { if (live) setUrls((current) => current[key] === url ? current : { ...current, [key]: url }); },
        () => { if (live) setUrls((current) => ({ ...current, [key]: null })); });
    }
    return () => { live = false; };
    // `resolve` is stable per store; the keys decide what to read.
  }, [joined]);
  return urls;
}
