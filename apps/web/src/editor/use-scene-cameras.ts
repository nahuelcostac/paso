import { useEffect, useState } from 'react';
import type { StepCameraSetting } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import type { ServiceEvent } from '../state/projects-store';

/** Saving one change emits several events. */
const RELOAD_DELAY_MS = 150;

/**
 * What each step of a scene says about the presentation camera, as the service has it, by step ID. The Lienzo needs it
 * to draw the camera a step keeps from an earlier one. It is read again when `version` changes and, given events,
 * whenever a step of this scene changes on the service, so an agent moving an earlier camera shows at once.
 */
export function useSceneCameras(api: ApiClient, projectId: string, sceneId: string | undefined, version: string, subscribeEvents?: (listener: (event: ServiceEvent) => void) => () => void) {
  const [cameras, setCameras] = useState<{ sceneId: string; byStep: Record<string, StepCameraSetting | undefined> }>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!sceneId) return;
    let cancelled = false;
    void api.listSteps(projectId, sceneId).then((listed) => {
      if (!cancelled) setCameras({ sceneId, byStep: Object.fromEntries(listed.map(({ document }) => [document.id, document.camera])) });
    }).catch(() => { /* The next change reads it again. */ });
    return () => { cancelled = true; };
  }, [api, projectId, sceneId, version, reads]);
  useEffect(() => {
    if (!subscribeEvents || !sceneId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeEvents((event) => {
      if (event.projectId !== projectId || event.kind !== 'step' || event.sceneId !== sceneId) return;
      clearTimeout(timer);
      timer = setTimeout(() => setReads((value) => value + 1), RELOAD_DELAY_MS);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [subscribeEvents, projectId, sceneId]);
  return cameras && cameras.sceneId === sceneId ? cameras.byStep : undefined;
}
