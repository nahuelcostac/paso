import { PREVIOUS_CAMERA, type StepCamera, type StepCameraSetting } from './format.js';

/** The camera a step is presented with, and the position of the step that owns it. */
export type ResolvedCamera = { camera: StepCamera; stepIndex: number };

/**
 * The presentation camera of the step at `index` in a scene's ordered steps. A step with its own box uses it. A step
 * that keeps the previous camera shows what the step before it shows, walking back through every step that keeps it
 * too: the first step that does not decides, with its own box or, without one, the whole scene. The first step of a
 * scene has nothing before it, so keeping the previous camera there shows the whole scene. Undefined means the whole
 * scene. The link is by position, so it follows reordering and deleting, and it is read anew every time.
 */
export function resolveStepCamera(steps: ReadonlyArray<{ camera?: StepCameraSetting }>, index: number): ResolvedCamera | undefined {
  for (let at = index; at >= 0; at--) {
    const camera = steps[at]?.camera;
    if (camera === PREVIOUS_CAMERA) continue;
    return camera ? { camera, stepIndex: at } : undefined;
  }
  return undefined;
}
