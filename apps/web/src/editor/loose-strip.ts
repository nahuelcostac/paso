import { useCallback, useState } from 'react';

/** What the person chose for a diagram's step strip. Without a choice it follows the kind of diagram. */
export type StripChoice = 'shown' | 'hidden';

const KEY = 'paso.loose-strip';

/**
 * Whether a diagram shows its step strip. A project's scene shows it; a loose diagram with one step opens as a plain
 * whiteboard, and with several it shows them. The person's choice wins, except that a diagram with no steps always
 * shows the strip: “Add step” is there.
 */
export function stripShown(steps: number, choice: StripChoice | undefined, loose = true): boolean {
  if (steps === 0) return true;
  if (choice) return choice === 'shown';
  return loose ? steps > 1 : true;
}

function readChoices(): Record<string, StripChoice> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? value as Record<string, StripChoice> : {};
  } catch { return {}; }
}

/** Where a diagram's choice is kept: a loose diagram by its scene, a project by itself, for all its scenes. */
export const stripKey = (projectId: string, sceneId: string, loose: boolean) => loose ? sceneId : `project:${projectId}`;

/**
 * The step strip of the diagram on the Canvas (its key from `stripKey`), as `stripShown` says. The choice is
 * remembered per diagram in this browser.
 */
export function useStepStrip(key: string | undefined, steps: number, loose: boolean) {
  const [choices, setChoices] = useState(readChoices);
  const shown = key === undefined || stripShown(steps, choices[key], loose);
  const choose = useCallback((choice: StripChoice) => {
    if (key === undefined) return;
    const next = { ...readChoices(), [key]: choice };
    setChoices(next);
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* a convenience: it just won't be remembered */ }
  }, [key]);
  return { shown, choose };
}
