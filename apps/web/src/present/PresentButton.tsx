import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play } from 'lucide-react';
import type { Scene } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import type { StepStore } from '../editor/step-store';
import type { ServiceEvent } from '../state/projects-store';
import { PresentFullscreen } from './fullscreen';
import '../styles/present.css';

const Presentation = lazy(() => import('./Presentation'));

/**
 * Presentar: the top bar's one primary action. Everything in the scene is saved before it starts, because the
 * presentation reads from the service. Local work that cannot be saved stops it, and the person is told why.
 */
export function PresentButton({ api, store, subscribeEvents, projectId, scene, stepId, onShowStep }: {
  api: ApiClient; store: StepStore; projectId: string; scene: Scene | undefined; stepId: string | undefined;
  subscribeEvents: (listener: (event: ServiceEvent) => void) => () => void;
  /** Leaving lands on the step last shown. */
  onShowStep: (sceneId: string, stepId: string) => void;
}) {
  const [presenting, setPresenting] = useState<{ sceneId: string; stepId: string | undefined }>();
  const [notice, setNotice] = useState<string>();
  const fullscreen = useMemo(() => new PresentFullscreen(), []);
  const button = useRef<HTMLButtonElement>(null);
  const preparing = useRef(false);
  const empty = !scene || scene.stepIds.length === 0;

  const start = async () => {
    if (empty || preparing.current) return;
    preparing.current = true;
    setNotice(undefined);
    try {
      await store.flushAll();
      // A step no longer in the scene will not be shown, whatever happened to it.
      const blocked = store.unresolved().find(({ target }) => target.projectId === projectId && target.sceneId === scene.id && scene.stepIds.includes(target.stepId));
      if (blocked) {
        const number = scene.stepIds.indexOf(blocked.target.stepId) + 1;
        setNotice(blocked.status === 'conflict' ? `No se puede presentar: el paso ${number} tiene un conflicto.` : `No se puede presentar: el paso ${number} no se pudo guardar.`);
        return;
      }
      // Saving is quick, so the browser still counts this as the person's click. If it took too long, fullscreen is refused and the presentation fills the window.
      fullscreen.enter();
      setPresenting({ sceneId: scene.id, stepId: scene.stepIds.includes(stepId ?? '') ? stepId : scene.stepIds[0] });
    } finally { preparing.current = false; }
  };
  const leave = (lastStepId: string | undefined, message?: string) => {
    fullscreen.exit();
    const sceneId = presenting?.sceneId;
    setPresenting(undefined);
    setNotice(message);
    if (sceneId && lastStepId && lastStepId !== stepId) onShowStep(sceneId, lastStepId);
    button.current?.focus();
  };
  // The browser's history can change the scene underneath. The presentation it belonged to ends.
  const sceneId = scene?.id;
  useEffect(() => {
    if (presenting && sceneId && sceneId !== presenting.sceneId) { fullscreen.exit(); setPresenting(undefined); }
  }, [presenting, sceneId, fullscreen]);
  useEffect(() => () => fullscreen.exit(), [fullscreen]);

  return <>
    {notice && <span className="topbar__error" role="alert"><span className="topbar__error-text" title={notice}>{notice}</span><button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => setNotice(undefined)}>×</button></span>}
    <button ref={button} type="button" className="btn btn--primary" disabled={empty} title={empty ? 'Esta escena no tiene pasos que presentar' : undefined} onClick={() => void start()}>
      <Play className="i" aria-hidden="true" />Presentar
    </button>
    {presenting && createPortal(<Suspense fallback={<div className="present" />}>
      <Presentation api={api} projectId={projectId} sceneId={presenting.sceneId} startStepId={presenting.stepId} subscribeEvents={subscribeEvents} fullscreen={fullscreen} onLeave={leave} />
    </Suspense>, document.body)}
  </>;
}
