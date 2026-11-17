import { useEffect, useRef, useState, type RefObject } from 'react';
import { Excalidraw, MainMenu, restore } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Check, Monitor, Moon, Sun, Library } from 'lucide-react';
import { chooseTheme, useThemeChoice, type ThemeChoice } from '../lib/theme';
import { canvasElements, canvasFiles, loadDrawingFonts } from './excalidraw-runtime';
import { loadFiles } from './assets';
import type { ApiClient } from '../lib/api';
import type { Session, StepStore } from './step-store';
import { cameraKey, fitOpeningDrawing, openingFit, type CanvasCamera } from './canvas-camera';
import type { ViewStore } from './canvas-view';
import { sceneFrame } from './scene-content';
import { clearHistory, finishTyping, swapStep } from './step-swap';
import { Loading } from './Loading';
import { canvasStepKey } from './step-keys';
import '../styles/editor.css';

/** Zen and view mode are how the person is looking, not part of a step: they carry over from one step to the next.
 * The grid is saved with each step, as Excalidraw saves it with a drawing. */
const looking = { zen: false, view: false };
type Modes = { grid: boolean; zen: boolean; view: boolean };
const modesOf = (appState: Pick<AppState, 'gridModeEnabled' | 'zenModeEnabled' | 'viewModeEnabled'>): Modes =>
  ({ grid: Boolean(appState.gridModeEnabled), zen: Boolean(appState.zenModeEnabled), view: Boolean(appState.viewModeEnabled) });
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** A menu row that turns something on or off: a check when it is on, with Excalidraw's own shortcut. */
function Toggle({ on, shortcut, onToggle, children }: { on: boolean; shortcut: string; onToggle: () => void; children: string }) {
  return <MainMenu.Item role="menuitemcheckbox" aria-checked={on} icon={on ? <Check aria-hidden="true" /> : <span aria-hidden="true" />}
    shortcut={shortcut} onSelect={onToggle}>{children}</MainMenu.Item>;
}

const THEMES: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Claro', icon: Sun }, { value: 'dark', label: 'Oscuro', icon: Moon }, { value: 'system', label: 'Sistema', icon: Monitor },
];
/** «Tema» with Claro, Oscuro and Sistema, in Excalidraw's own radio row markup so it looks like its menu. Its built-in row
 * says «Theme»: es-ES does not translate that label in 0.18.1. */
function ThemeRow({ choice }: { choice: ThemeChoice }) {
  return <div className="dropdown-menu-item-base dropdown-menu-item-bare">
    <label className="dropdown-menu-item__text" htmlFor="paso-theme">Tema</label>
    <div className="RadioGroup" role="radiogroup" aria-label="Tema">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <div key={value} className={`RadioGroup__choice${value === choice ? ' active' : ''}`} title={label}>
          <input id={value === 'light' ? 'paso-theme' : undefined} name="paso-theme" type="radio" checked={value === choice} aria-label={label} onChange={() => chooseTheme(value)} />
          <Icon className="i" aria-hidden="true" />
        </div>
      ))}
    </div>
  </div>;
}

const failure = 'No se pudo preparar el guardado. Conserva esta ventana abierta.';

/**
 * The Lienzo's one Excalidraw. Moving to another step does not mount it again: the next step is prepared beside the
 * one on screen (its images, its fonts, its text measured) and then swapped in with a single update, so the drawing
 * on screen stays until the next one is ready. Only the first step opened, a canvas that failed, or a canvas that is
 * still starting are mounted afresh.
 */
export default function StepCanvas({ api, store, session, theme, keepFocus, camera, onStepKey, view, onShow }: {
  api: ApiClient; store: StepStore;
  /** The step the Lienzo asks for. Undefined while the store is still reading it: the canvas keeps what it shows. */
  session: Session | undefined;
  theme: 'light' | 'dark'; keepFocus: () => boolean; camera: RefObject<CanvasCamera | undefined>;
  /** ← → (and Page Up, Page Down) on the canvas, when they would do nothing in the drawing: the previous or next step. */
  onStepKey?: (delta: -1 | 1) => void;
  /** Told what the canvas shows on every change: the Lienzo draws the step's presentation camera from it. */
  view?: ViewStore;
  /** Told which step is on screen, once it is: the Lienzo's camera controls and notices belong to that one. */
  onShow?: (session: Session | undefined) => void;
}) {
  const mounted = useRef(false);
  const focusCanvas = useRef(true);
  const [data, setData] = useState<{ key: number; initial: ExcalidrawInitialDataState }>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string>();
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI>();
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  /** The step on screen, which the canvas's changes belong to. It changes in the same moment as the drawing. */
  const shownRef = useRef<Session>(undefined);
  const [shown, setShown] = useState<Session>();
  /** Excalidraw has finished starting. Before then a swap would be overwritten by its own initial scene. */
  const ready = useRef(false);
  const mounts = useRef(0);
  /** A swap just happened. Excalidraw may record what was pending from the step left (a selection, say) in the same
   * update, after the swap cleared its history: the first change after a swap clears it again. */
  const swapped = useRef(false);
  const frame = useRef<readonly ExcalidrawElement[]>(undefined);
  const openOnce = useRef(openingFit(true));
  const [modes, setModes] = useState<Modes>({ grid: Boolean(session?.document.appState.gridModeEnabled), ...looking });
  const themeChoice = useThemeChoice();
  const excalidrawTheme = useRef(theme);
  const onShowRef = useRef(onShow); onShowRef.current = onShow;
  const toggle = (key: keyof Modes) => {
    const next = { ...modes, [key]: !modes[key] };
    excalidraw?.updateScene({ appState: { gridModeEnabled: next.grid, zenModeEnabled: next.zen, viewModeEnabled: next.view } });
  };
  const show = (next: Session | undefined) => { shownRef.current = next; setShown(next); onShowRef.current?.(next); };
  /** Hands the store what the canvas holds now, so the step being left keeps its last edit even if Excalidraw has not reported it yet. */
  const capture = (app: ExcalidrawImperativeAPI, owner: Session) => {
    try { store.change(owner, app.getSceneElementsIncludingDeleted(), app.getAppState(), app.getFiles()); }
    catch { store.fail(owner, failure); }
  };
  // A canvas that goes (a failed load, another diagram) shows no step any more: the Lienzo's controls go with it.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onShowRef.current?.(undefined); }; }, []);
  useEffect(() => {
    // Undefined while the store reads the step; the same session when it is already on screen.
    if (!session || session === shownRef.current) return;
    let cancelled = false;
    const sameScene = (key: string | undefined) => key === cameraKey(session.target);
    // Moving to another step of the same scene keeps the camera. A scene opened afresh is fitted to all its steps.
    const keepCamera = sameScene(shownRef.current ? cameraKey(shownRef.current.target) : camera.current?.key);
    void (async () => {
      const { projectId, sceneId } = session.target;
      const [files, box] = await Promise.all([
        loadDrawingFonts([session.document]).then(() => loadFiles(api, projectId, session.document, session.binaries)),
        // Without a frame the step is fitted on its own: a scene that cannot be listed still opens.
        keepCamera ? undefined : api.listSteps(projectId, sceneId).then((listed) => sceneFrame(listed.map(({ document }) => document))).catch(() => undefined),
      ]);
      if (cancelled) return;
      const restored = restore({ elements: canvasElements(session.document), appState: session.document.appState, files: canvasFiles(files) }, null, null, { refreshDimensions: true });
      const app = excalidrawRef.current;
      const previous = shownRef.current;
      if (app && previous && ready.current) {
        finishTyping(wrapper.current);
        capture(app, previous);
        // A canvas that shows a session owns it: its first change after the swap is the baseline, not an edit.
        session.baseline = undefined;
        shownRef.current = session;
        swapStep(app, restored, looking);
        swapped.current = true;
        if (!sameScene(cameraKey(previous.target))) fitOpeningDrawing(app, box);
        // As a new canvas would: the canvas takes focus, unless the keyboard works the carousel or someone is typing elsewhere.
        const active = document.activeElement;
        const typing = active instanceof HTMLElement && !wrapper.current?.contains(active) && active.closest('input, textarea, select, [contenteditable="true"]');
        if (!keepFocus() && !typing) wrapper.current?.querySelector<HTMLElement>('.excalidraw-container')?.focus({ preventScroll: true });
        show(session);
        return;
      }
      // The first step, or a canvas that is not ready yet: Excalidraw starts with this step.
      const opening = keepCamera ? camera.current : undefined;
      frame.current = box;
      openOnce.current = openingFit(Boolean(opening), () => frame.current);
      // Excalidraw takes focus when it mounts. Not while the keyboard is moving through the carousel.
      focusCanvas.current = !keepFocus();
      ready.current = false;
      session.baseline = undefined;
      setModes({ grid: Boolean(restored.appState.gridModeEnabled), ...looking });
      setData({ key: ++mounts.current, initial: { ...restored, appState: { ...restored.appState, ...opening, zenModeEnabled: looking.zen, viewModeEnabled: looking.view }, scrollToContent: !opening } });
      show(session);
    })().catch(() => {
      if (cancelled) return;
      // The canvas gives way to the message. What it held is the store's first.
      const app = excalidrawRef.current, previous = shownRef.current;
      if (app && previous && ready.current) capture(app, previous);
      ready.current = false; excalidrawRef.current = null;
      setData(undefined); show(undefined);
      setError('No se pudo cargar el dibujo o una de sus imágenes.');
    });
    return () => { cancelled = true; };
  }, [api, session, retry]);
  // ← → on the canvas change step when they would do nothing in the drawing (canvasStepKey). Captured before
  // Excalidraw, which would otherwise take them.
  useEffect(() => {
    if (!onStepKey) return;
    const press = (event: KeyboardEvent) => {
      const app = excalidrawRef.current;
      // Presentar has the keys while it is open.
      if (!app || document.querySelector('.present')) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const delta = canvasStepKey(event, target, target === document.body, app.getAppState());
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      onStepKey(delta);
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, [onStepKey]);
  if (error) return <div className="editor-message" role="alert">{error}<button className="btn" onClick={() => { setError(undefined); setRetry((value) => value + 1); }}>Reintentar</button></div>;
  if (!data) return <Loading>Cargando dibujo…</Loading>;
  return <div className="step-canvas" ref={wrapper} data-step-id={shown?.target.stepId}>
    <Excalidraw key={data.key} initialData={data.initial} theme={theme} langCode="es-ES" autoFocus={focusCanvas.current} handleKeyboardGlobally={false}
      validateEmbeddable={false} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: true, export: false } }} /* toggleTheme: Alt+Shift+D */
      excalidrawAPI={(instance) => { excalidrawRef.current = instance; setExcalidraw(instance); }}
      onChange={(elements, appState, files) => {
        const owner = shownRef.current;
        if (!mounted.current || !owner) return;
        if (!appState.isLoading && excalidrawRef.current) {
          ready.current = true;
          if (swapped.current) { swapped.current = false; clearHistory(excalidrawRef.current, wrapper.current); }
          if (!openOnce.current(excalidrawRef.current)) {
            camera.current = { key: cameraKey(owner.target), scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom };
          }
          view?.set({ scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, width: appState.width, height: appState.height });
        }
        // The menu and Excalidraw's own shortcuts both land here: keep the menu's checks and the next step in step.
        const next = modesOf(appState);
        if (next.grid !== modes.grid || next.zen !== modes.zen || next.view !== modes.view) {
          looking.zen = next.zen; looking.view = next.view;
          setModes(next);
        }
        // Alt+Shift+D switches Excalidraw's theme by itself: make it the window's theme too. Only a change Excalidraw
        // made counts: while a new theme prop is on its way in, its appState still holds the old one for a moment.
        if (appState.theme !== excalidrawTheme.current) {
          excalidrawTheme.current = appState.theme;
          if (appState.theme !== theme) chooseTheme(appState.theme);
        }
        try { store.change(owner, elements, appState, files); setError(undefined); }
        catch { store.fail(owner, failure); }
      }}>
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.Separator />
        <MainMenu.Group title="Preferencias">
          <Toggle on={modes.grid} shortcut={mac ? "Cmd+'" : "Ctrl+'"} onToggle={() => toggle('grid')}>Mostrar cuadrícula</Toggle>
          <Toggle on={modes.zen} shortcut="Alt+Z" onToggle={() => toggle('zen')}>Modo zen</Toggle>
          <Toggle on={modes.view} shortcut="Alt+R" onToggle={() => toggle('view')}>Modo vista</Toggle>
          <ThemeRow choice={themeChoice} />
        </MainMenu.Group>
        <MainMenu.Separator />
        {/* The library's own button gave its corner to Presentar: the library opens from here. */}
        <MainMenu.Item icon={<Library aria-hidden="true" />} onSelect={() => excalidrawRef.current?.toggleSidebar({ name: 'default', tab: 'library' })}>Biblioteca</MainMenu.Item>
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  </div>;
}
