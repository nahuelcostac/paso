import { useEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, restore } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { canvasElements, canvasFiles, loadDrawingFonts } from './excalidraw-runtime';
import { loadFiles } from './assets';
import type { ApiClient } from '../lib/api';
import type { Session, StepStore } from './step-store';
import '../styles/editor.css';

export default function StepCanvas({ api, store, session, theme }: { api: ApiClient; store: StepStore; session: Session; theme: 'light' | 'dark' }) {
  const mounted = useRef(false);
  const [data, setData] = useState<ExcalidrawInitialDataState>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    // A new mounted canvas owns this session. Late callbacks from an old canvas retain its target.
    session.baseline = undefined;
    void (async () => {
      await loadDrawingFonts([session.document]);
      const files = await loadFiles(api, session.target.projectId, session.document, session.binaries);
      const restored = restore({ elements: canvasElements(session.document), appState: session.document.appState, files: canvasFiles(files) }, null, null, { refreshDimensions: true });
      if (!cancelled) setData({ ...restored, scrollToContent: true });
    })().catch(() => { if (!cancelled) setError('No se pudo cargar el dibujo o una de sus imágenes.'); });
    return () => { cancelled = true; mounted.current = false; };
  }, [api, session, retry]);
  if (error) return <div className="editor-message" role="alert">{error}<button className="btn" onClick={() => { setError(undefined); setRetry((value) => value + 1); }}>Reintentar</button></div>;
  if (!data) return <div className="editor-message" aria-busy="true">Cargando dibujo…</div>;
  return <div className="step-canvas" data-step-id={session.target.stepId}>
    <Excalidraw initialData={data} theme={theme} langCode="es-ES" autoFocus handleKeyboardGlobally={false}
      validateEmbeddable={false} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: false } }}
      onChange={(elements, appState, files) => {
        if (!mounted.current) return;
        try { store.change(session, elements, appState, files); setError(undefined); }
        catch { store.fail(session, 'No se pudo preparar el guardado. Conserva esta ventana abierta.'); }
      }}>
      <MainMenu><MainMenu.DefaultItems.SaveAsImage /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
    </Excalidraw>
  </div>;
}
