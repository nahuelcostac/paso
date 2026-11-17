import { useCallback, useState } from 'react';

/** What the person chose for a loose diagram's step strip. Without a choice it follows the steps. */
export type StripChoice = 'shown' | 'hidden';

const KEY = 'paso.loose-strip';

/**
 * Whether a loose diagram shows its step strip. With one step it opens as a plain whiteboard; with several it shows
 * them. The person's choice wins, except that a diagram with no steps always shows the strip: «Añadir paso» is there.
 */
export function stripShown(steps: number, choice: StripChoice | undefined): boolean {
  if (steps === 0) return true;
  return choice ? choice === 'shown' : steps > 1;
}

function readChoices(): Record<string, StripChoice> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? value as Record<string, StripChoice> : {};
  } catch { return {}; }
}

/**
 * The step strip of the diagram on the Lienzo: always shown for a project's scene, and for a loose diagram (its scene
 * ID given) as `stripShown` says. The choice is remembered per diagram in this browser.
 */
export function useLooseStrip(looseId: string | undefined, steps: number) {
  const [choices, setChoices] = useState(readChoices);
  const shown = looseId === undefined || stripShown(steps, choices[looseId]);
  const choose = useCallback((choice: StripChoice) => {
    if (looseId === undefined) return;
    const next = { ...readChoices(), [looseId]: choice };
    setChoices(next);
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* a convenience: it just won't be remembered */ }
  }, [looseId]);
  return { shown, choose };
}
