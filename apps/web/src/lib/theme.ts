import { useSyncExternalStore } from 'react';

/** The person's theme: light, dark, or whatever the system says. */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'paso.theme';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}
let current: ThemeChoice = typeof window === 'undefined' ? 'system' : read();

/**
 * Applies a theme to the whole window: data-theme on <html>, which tokens.css and useTheme already follow.
 * «Sistema» removes it, so the OS decides. The choice is remembered in this browser only.
 */
export function chooseTheme(choice: ThemeChoice) {
  current = choice;
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch { /* a convenience: the choice just won't be remembered */ }
  listeners.forEach((listener) => listener());
}

/** Applies the remembered choice before the first render, so the window does not flash the other theme. */
export function restoreTheme() {
  current = read();
  if (current !== 'system') document.documentElement.dataset.theme = current;
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => 'system');
}
