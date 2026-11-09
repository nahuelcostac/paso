import { useEffect, useRef, useState, type RefObject } from 'react';
import { Excalidraw, MainMenu, restore } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { chooseTheme, useThemeChoice, type ThemeChoice } from '../lib/theme';
import { canvasElements, canvasFiles, loadDrawingFonts } from './excalidraw-runtime';
import { loadFiles } from './assets';
import type { ApiClient } from '../lib/api';
import { targetKey, type Session, type StepStore } from './step-store';
import { openingFit, type CanvasCamera } from './canvas-camera';
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

export default function StepCanvas({ api, store, session, theme, keepFocus, camera }: { api: ApiClient; store: StepStore; session: Session; theme: 'light' | 'dark'; keepFocus: () => boolean; camera: RefObject<CanvasCamera | undefined> }) {
  const mounted = useRef(false);
  const focusCanvas = useRef(true);
  const [data, setData] = useState<ExcalidrawInitialDataState>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string>();
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI>();
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const openingCamera = useRef(camera.current?.key === targetKey(session.target) ? camera.current : undefined);
  const openOnce = useRef(openingFit(Boolean(openingCamera.current)));
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
      await loadDrawingFonts([session.document]);
      const files = await loadFiles(api, session.target.projectId, session.document, session.binaries);
      const restored = restore({ elements: canvasElements(session.document), appState: session.document.appState, files: canvasFiles(files) }, null, null, { refreshDimensions: true });
      // Excalidraw takes focus when it mounts. Not while the keyboard is moving through the carousel.
      focusCanvas.current = !keepFocus();
      if (!cancelled) setData({ ...restored, appState: { ...restored.appState, ...openingCamera.current, zenModeEnabled: looking.zen, viewModeEnabled: looking.view }, scrollToContent: !openingCamera.current });
    })().catch(() => { if (!cancelled) setError('No se pudo cargar el dibujo o una de sus imágenes.'); });
    return () => { cancelled = true; mounted.current = false; };
  }, [api, session, retry]);
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
            camera.current = { key: targetKey(session.target), scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom };
          }
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
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  </div>;
}
