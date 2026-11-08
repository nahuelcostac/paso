// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseTheme, restoreTheme, useThemeChoice } from './theme';

afterEach(() => { chooseTheme('system'); window.localStorage.clear(); });

describe('the theme choice', () => {
  it('sets data-theme on the window and remembers it; «Sistema» hands the choice back to the OS', () => {
    chooseTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('paso.theme')).toBe('dark');
    chooseTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem('paso.theme')).toBeNull();
  });

  it('restores the remembered choice before the app renders', () => {
    window.localStorage.setItem('paso.theme', 'light');
    restoreTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    const { result } = renderHook(() => useThemeChoice());
    expect(result.current).toBe('light');
  });

  it('ignores a stored value it does not know, and tells every reader about a new choice', () => {
    window.localStorage.setItem('paso.theme', 'sepia');
    restoreTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const { result } = renderHook(() => useThemeChoice());
    expect(result.current).toBe('system');
    act(() => chooseTheme('dark'));
    expect(result.current).toBe('dark');
  });
});
