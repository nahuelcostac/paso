import { useEffect, useState } from 'react';
import { ImageOff, X } from 'lucide-react';

/**
 * One chip of an attachments row: what goes with a message, in the composer and in the conversation. Each kind has its
 * own look and keeps the row, its order and its remove button: an image is a thumbnail, a Studio step a chip with its
 * number, its scene and its title.
 */
export type AttachmentItem = {
  key: string;
  kind: 'image';
  /** What the chip is called, for its title and for screen readers: an image's file name. */
  label: string;
  /** An image's picture. Absent while it loads; `failed` when it couldn't be read. */
  src?: string;
  failed?: boolean;
} | {
  key: string;
  kind: 'step';
  /** What the chip is called, for its tooltip and for screen readers. */
  label: string;
  /** The step's number in its scene, as two digits. Absent once the step is gone. */
  number?: string;
  scene: string;
  /** The step's title, or empty when it has none. */
  title: string;
  /** The step was deleted: it is said on the chip, and it is not sent. */
  missing?: boolean;
  /** Opens the step. Without it (a deleted step) the chip is only text. */
  onOpen?: () => void;
};

function StepChip({ item }: { item: Extract<AttachmentItem, { kind: 'step' }> }) {
  // “Scene · 02 Title”: where it is, its number as on its card, and its title.
  const body = <>
    <span className="attachment__scene">{item.scene}</span>
    <span className="attachment__sep" aria-hidden="true">·</span>
    {item.number && <span className="attachment__num">{item.number}</span>}
    <span className={`attachment__title${item.title ? '' : ' attachment__title--empty'}`}>{item.title || 'Untitled'}</span>
    {item.missing && <span className="attachment__gone">Deleted</span>}
  </>;
  return item.onOpen && !item.missing
    ? <button type="button" className="attachment__step" aria-label={`Open ${item.label}`} title={`Open ${item.label}`} onClick={item.onOpen}>{body}</button>
    : <span className="attachment__step" role="img" aria-label={item.label} title={item.label}>{body}</span>;
}

/** A row of attachments. With `onRemove` each chip has an × to take it off the message. */
export function AttachmentRow({ items, label, onRemove, className }: {
  items: AttachmentItem[]; label: string; onRemove?: (key: string) => void; className?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className={`attachments${className ? ` ${className}` : ''}`} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={`attachment attachment--${item.kind}`} data-missing={(item.kind === 'step' && item.missing) || undefined} title={item.kind === 'image' ? item.label : undefined}>
          {item.kind === 'step' ? <StepChip item={item} />
            : item.src ? <img src={item.src} alt={item.label} draggable={false} />
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
