import { useRef, useState } from 'react';

type Props = {
  initial: string;
  placeholder?: string;
  label: string;
  /** Resolves when saved. Rejects with the words to show if it failed. */
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
  /** The person walked away after a failure: nothing was saved. */
  onAbandon: (message: string) => void;
};

/**
 * Inline name editing. Enter or leaving the field saves, Escape cancels. A failure stays under the field
 * so the name is not lost; leaving after a failure gives up and reports it instead.
 */
export function NameField({ initial, placeholder, label, onSave, onCancel, onAbandon }: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finished = useRef(false);

  const save = async () => {
    const name = value.trim();
    if (finished.current || busy) return;
    if (!name || name === initial) { finished.current = true; onCancel(); return; }
    setBusy(true); setError(null);
    try { await onSave(name); finished.current = true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); setBusy(false); }
  };

  return (
    <div className="namefield">
      <input
        autoFocus
        value={value}
        maxLength={120}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        disabled={busy}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => { setValue(event.target.value); setError(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void save(); }
          else if (event.key === 'Escape') { event.stopPropagation(); finished.current = true; onCancel(); }
        }}
        onBlur={() => {
          if (finished.current || busy) return;
          if (error) { finished.current = true; onAbandon(error); } else void save();
        }}
      />
      {error && <p className="namefield__error" role="alert">{error}</p>}
    </div>
  );
}
