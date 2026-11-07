import type { Scene, Step } from '@paso/shared';
import { ApiRequestError, type ApiClient } from '../lib/api';
import type { StepStore, Target } from './step-store';

/** The part of the API the structure actions use. A real ApiClient satisfies it. */
export type StructureApi = Pick<ApiClient, 'getScene' | 'getStep' | 'createScene' | 'createStep' | 'duplicateStep' | 'reorderSteps'>;
export type SceneEnvelope = { document: Scene; revision: string };

/** A failure the person can read. `message` is a complete Spanish sentence. */
export class StructureError extends Error {}

const unsaved = () => new StructureError('Este paso tiene cambios sin guardar. Revisa el aviso, resuélvelo e inténtalo de nuevo.');
const stale = () => new StructureError('La escena cambió fuera de Paso. Ya está actualizada: inténtalo de nuevo.');

/**
 * Everything that changes a scene's list of steps. It runs one action at a time, so two quick presses
 * never read the same order, and it goes through the step store: pending edits are saved first,
 * and a copy is always made from what is on the service after that save.
 */
export class StepActions {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private api: StructureApi, private store: StepStore) {}

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Saves pending edits to a step and returns what is now on the service. A step that cannot be saved stops the action. */
  private async settled(target: Target): Promise<Step | undefined> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.store.flush(target);
      const session = this.store.session(target);
      if (!session) return undefined;
      if (session.status === 'saved') return session.document;
      if (session.status !== 'dirty' && session.status !== 'saving') break;
    }
    throw unsaved();
  }

  private async failure<T>(job: () => Promise<T>): Promise<T> {
    try { return await job(); }
    catch (error) {
      if (error instanceof StructureError) throw error;
      if (error instanceof ApiRequestError && (error.status === 409 || error.status === 428)) throw stale();
      if (error instanceof ApiRequestError && error.status === 404) throw new StructureError('El paso o la escena ya no existe.');
      throw new StructureError('No se pudo completar la acción. Inténtalo de nuevo.');
    }
  }

  /** Puts `stepId` at `index` in the scene as it is now on the service. Returns the scene. */
  private async place(projectId: string, sceneId: string, stepId: string, index: number | 'end'): Promise<SceneEnvelope> {
    for (let attempt = 0; ; attempt++) {
      const scene = await this.api.getScene(projectId, sceneId);
      const rest = scene.document.stepIds.filter((id) => id !== stepId);
      rest.splice(index === 'end' ? rest.length : Math.max(0, Math.min(index, rest.length)), 0, stepId);
      if (rest.join() === scene.document.stepIds.join()) return scene;
      try { return await this.api.reorderSteps(projectId, sceneId, scene.revision, rest); }
      catch (error) { if (attempt < 2 && error instanceof ApiRequestError && error.status === 409) continue; throw error; }
    }
  }

  /** A new scene with one blank step. */
  createScene(projectId: string, name: string) {
    return this.serial(() => this.failure(async () => {
      const scene = await this.api.createScene(projectId, name);
      const step = await this.api.createStep(projectId, scene.document.id);
      return { sceneId: scene.document.id, stepId: step.document.id };
    }));
  }

  /**
   * "Añadir paso": a new step right after `after`, starting as a copy of its drawing, with no title and no
   * speaker notes, because it is a new beat. Without `after` (an empty scene) the step is blank.
   */
  add(projectId: string, sceneId: string, after?: string) {
    return this.serial(() => this.failure(async () => {
      const source = after ? await this.settled({ projectId, sceneId, stepId: after }) : undefined;
      const body = source ? { elements: source.elements, appState: source.appState, files: source.files } : {};
      const created = await this.api.createStep(projectId, sceneId, body);
      const at = after ? (await this.api.getScene(projectId, sceneId)).document.stepIds.indexOf(after) + 1 : 'end';
      await this.place(projectId, sceneId, created.document.id, at === 0 ? 'end' : at);
      return created.document.id;
    }));
  }

  /** "Duplicar paso": an exact copy of `target`, title and notes included, right after it. */
  duplicate(target: Target) {
    return this.serial(() => this.failure(async () => {
      for (let attempt = 0; ; attempt++) {
        await this.settled(target);
        // The revision of what the service holds after the save above, or a fresh read for a step never opened.
        const revision = this.store.session(target)?.revision ?? (await this.api.getStep(target)).revision;
        let copy;
        try { copy = await this.api.duplicateStep(target, revision); }
        catch (error) {
          // An edit saved between the flush and the copy changes the revision. Flush again and retry.
          if (attempt < 2 && error instanceof ApiRequestError && error.status === 409) continue;
          throw error;
        }
        try {
          const scene = await this.api.getScene(target.projectId, target.sceneId);
          await this.place(target.projectId, target.sceneId, copy.document.id, scene.document.stepIds.filter((id) => id !== copy.document.id).indexOf(target.stepId) + 1);
        } catch { throw new StructureError('El paso se duplicó, pero no se pudo colocar justo después del original. Está al final de la escena.'); }
        return copy.document.id;
      }
    }));
  }

  /** Moves a step to `index` (0-based, in the order after the move). */
  move(projectId: string, sceneId: string, stepId: string, index: number) {
    return this.serial(() => this.failure(async () => (await this.place(projectId, sceneId, stepId, index)).document.stepIds));
  }
  /** Moves a step one place. The position is read when the action runs, so held-down keys keep working. */
  nudge(projectId: string, sceneId: string, stepId: string, delta: -1 | 1) {
    return this.serial(() => this.failure(async () => {
      const ids = (await this.api.getScene(projectId, sceneId)).document.stepIds;
      const at = ids.indexOf(stepId);
      if (at < 0) throw stale();
      const to = at + delta;
      if (to < 0 || to >= ids.length) return { index: at, count: ids.length };
      await this.place(projectId, sceneId, stepId, to);
      return { index: to, count: ids.length };
    }));
  }

  /** Deletes a step. Returns the step the person should land on: the next one, or the previous when it was the last. */
  remove(target: Target) {
    return this.serial(() => this.failure(async () => {
      const ids = (await this.api.getScene(target.projectId, target.sceneId)).document.stepIds;
      const at = ids.indexOf(target.stepId);
      await this.store.remove(target);
      return at < 0 ? ids[0] : ids[at + 1] ?? ids[at - 1];
    }));
  }
}
