import { useSyncExternalStore } from 'react';

/** How the person is looking at the canvas: the grid is saved with each step; zen and view mode carry over. */
export type CanvasModes = { grid: boolean; zen: boolean; view: boolean };

/**
 * What the gear menu in the activity bar can do to the canvas on screen. The Canvas's Excalidraw hands it over while it
 * shows a step, and takes it back when it goes, so the menu knows when there is no canvas to act on (the Studio, a step
 * that is still loading).
 */
export type CanvasMenuHandle = {
  modes: CanvasModes;
  /** The step's canvas colour, as Excalidraw holds it. */
  background: string;
  toggle: (mode: keyof CanvasModes) => void;
  /** Excalidraw's own “Export image” dialog. */
  exportImage: () => void;
  /** Opens or closes Excalidraw's library, in its sidebar. */
  toggleLibrary: () => void;
  setBackground: (color: string) => void;
};

export type CanvasMenu = {
  get: () => CanvasMenuHandle | undefined;
  set: (handle: CanvasMenuHandle | undefined) => void;
  subscribe: (listener: () => void) => () => void;
};

/** One per window: the bar outlives the Canvas, which mounts and unmounts with the view. Kept free of Excalidraw. */
export function createCanvasMenu(): CanvasMenu {
  let current: CanvasMenuHandle | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (handle) => { current = handle; listeners.forEach((listener) => listener()); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function useCanvasMenu(menu: CanvasMenu) {
  return useSyncExternalStore(menu.subscribe, menu.get, menu.get);
}

/** Excalidraw's own first canvas colours (DEFAULT_CANVAS_BACKGROUND_PICKS in 0.18.1), with Paso's names for them. */
export const CANVAS_BACKGROUNDS = [
  { color: '#ffffff', name: 'White' },
  { color: '#f8f9fa', name: 'Light grey' },
  { color: '#f5faff', name: 'Light blue' },
  { color: '#fffce8', name: 'Light yellow' },
  { color: '#fdf8f6', name: 'Light rose' },
] as const;
