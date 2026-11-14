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
import { cameraKey, openingFit, type CanvasCamera } from './canvas-camera';
import type { ViewStore } from './canvas-view';
import { sceneFrame } from './scene-content';
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

export default function StepCanvas({ api, store, session, theme, keepFocus, camera, onStepKey, view }: {
  api: ApiClient; store: StepStore; session: Session; theme: 'light' | 'dark'; keepFocus: () => boolean; camera: RefObject<CanvasCamera | undefined>;
  /** ← → (and Page Up, Page Down) on the canvas, when they would do nothing in the drawing: the previous or next step. */
  onStepKey?: (delta: -1 | 1) => void;
  /** Told what the canvas shows on every change: the Lienzo draws the step's presentation camera from it. */
  view?: ViewStore;
}) {
  const mounted = useRef(false);
  const focusCanvas = useRef(true);
  const [data, setData] = useState<ExcalidrawInitialDataState>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string>();
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI>();
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // Moving to another step of the same scene keeps the camera. A scene opened afresh is fitted to all its steps.
  const openingCamera = useRef(camera.current?.key === cameraKey(session.target) ? camera.current : undefined);
  const frame = useRef<readonly ExcalidrawElement[]>(undefined);
  const openOnce = useRef(openingFit(Boolean(openingCamera.current), () => frame.current));
  const [modes, setModes] = useState<Modes>({ grid: Boolean(session.document.appState.gridModeEnabled), ...looking });
  const themeChoice = useThemeChoice();
  const excalidrawTheme = useRef(theme);
  const toggle = (key: keyof Modes) => {
    const next = { ...modes, [key]: !modes[key] };
    excalidraw?.updateScene({ appState: { gridModeEnabled: next.grid, zenModeEnabled: next.zen, viewModeEnabled: next.view } });
  };
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    // A new mounted canvas owns this session. Late callbacks from an old canvas retain its target.
    session.baseline = undefined;
    void (async () => {
      const { projectId, sceneId } = session.target;
      const [files] = await Promise.all([
        loadDrawingFonts([session.document]).then(() => loadFiles(api, projectId, session.document, session.binaries)),
        // Without a frame the step is fitted on its own: a scene that cannot be listed still opens.
        openingCamera.current ? undefined : api.listSteps(projectId, sceneId).then((listed) => sceneFrame(listed.map(({ document }) => document)))
          .then((box) => { frame.current = box; }, () => undefined),
      ]);
      const restored = restore({ elements: canvasElements(session.document), appState: session.document.appState, files: canvasFiles(files) }, null, null, { refreshDimensions: true });
      // Excalidraw takes focus when it mounts. Not while the keyboard is moving through the carousel.
      focusCanvas.current = !keepFocus();
      if (!cancelled) setData({ ...restored, appState: { ...restored.appState, ...openingCamera.current, zenModeEnabled: looking.zen, viewModeEnabled: looking.view }, scrollToContent: !openingCamera.current });
    })().catch(() => { if (!cancelled) setError('No se pudo cargar el dibujo o una de sus imágenes.'); });
    return () => { cancelled = true; mounted.current = false; };
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
  if (!data) return <div className="editor-message" aria-busy="true">Cargando dibujo…</div>;
  return <div className="step-canvas" data-step-id={session.target.stepId}>
    <Excalidraw initialData={data} theme={theme} langCode="es-ES" autoFocus={focusCanvas.current} handleKeyboardGlobally={false}
      validateEmbeddable={false} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: true, export: false } }} /* toggleTheme: Alt+Shift+D */
      excalidrawAPI={(instance) => { excalidrawRef.current = instance; setExcalidraw(instance); }}
      onChange={(elements, appState, files) => {
        if (!mounted.current) return;
        if (!appState.isLoading && excalidrawRef.current) {
          if (!openOnce.current(excalidrawRef.current)) {
            camera.current = { key: cameraKey(session.target), scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom };
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
        try { store.change(session, elements, appState, files); setError(undefined); }
        catch { store.fail(session, 'No se pudo preparar el guardado. Conserva esta ventana abierta.'); }
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
