import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { idSchema, parseProject, parseScene, parseStep, validateProjectTree, type Project, type ProjectTree, type Scene, type Step } from '@paso/shared';
import { z } from 'zod';
import { type RecordFile } from './disk.js';
import { ApiError, isMissing } from './errors.js';
import type { Store } from './store.js';

export const DEFAULT_RUN_RETENTION_LIMIT = 10;

const runStatusSchema = z.enum(['running', 'finished', 'interrupted', 'undone']);
export type RunStatus = z.infer<typeof runStatusSchema>;

const runSnapshotSchema = z.object({
  project: z.custom<Project>((val) => { parseProject(val); return true; }),
  projectRevision: z.string(),
  scenes: z.record(idSchema, z.object({
    document: z.custom<Scene>((val) => { parseScene(val); return true; }),
    revision: z.string(),
  }).strict()),
  steps: z.record(idSchema, z.object({
    sceneId: idSchema,
    document: z.custom<Step>((val) => { parseStep(val); return true; }),
    revision: z.string(),
    rawText: z.string().optional(),
  }).strict()),
}).strict();

const runEndStateSchema = z.object({
  projectSceneIds: z.array(idSchema),
  scenes: z.record(idSchema, z.object({
    name: z.string(),
    stepIds: z.array(idSchema),
  }).strict()),
  stepRevisions: z.record(idSchema, z.string()),
}).strict();

const runTouchLogSchema = z.object({
  createdScenes: z.array(idSchema),
  createdSteps: z.record(idSchema, idSchema),
  touchedSteps: z.record(idSchema, z.object({
    sceneId: idSchema,
    lastRevision: z.string(),
    hadConcurrentEdit: z.boolean().optional(),
  }).strict()),
  humanEditedSteps: z.record(idSchema, z.string()).optional(),
  reorderedProject: z.boolean(),
  reorderedScenes: z.array(idSchema),
}).strict();

const storedRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  projectId: idSchema,
  status: runStatusSchema,
  label: z.string().min(1).max(200).optional(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  undoneAt: z.iso.datetime({ offset: true }).nullable(),
  baseline: runSnapshotSchema,
  touched: runTouchLogSchema,
  endState: runEndStateSchema.optional(),
}).strict();

export type StoredRun = z.infer<typeof storedRunSchema>;

export type UndoWarning = {
  code: 'STEP_MODIFIED_CONCURRENTLY' | 'STEP_MODIFIED_AFTER_RUN' | 'STEP_DELETED' | 'SCENE_DELETED' | 'SCENE_HAS_POST_RUN_STEPS' | 'ORDER_MODIFIED_AFTER_RUN';
  kind: 'project' | 'scene' | 'step';
  id: string;
  sceneId?: string;
  title?: string;
  message: string;
};

export type UndoPlan = {
  runId: string;
  projectId: string;
  status: RunStatus;
  canUndo: boolean;
  requiresForce: boolean;
  confirmationToken: string;
  changes: {
    stepsToRestore: Array<{ id: string; sceneId: string; title?: string; currentRevision: string; restoreRevision: string }>;
    stepsToRecreate: Array<{ id: string; sceneId: string; title?: string; restoreRevision: string }>;
    stepsToDelete: Array<{ id: string; sceneId: string; title?: string; currentRevision: string }>;
    scenesToDelete: Array<{ id: string; name: string; currentRevision: string }>;
    scenesToKeepWithPostRunSteps: Array<{ id: string; name: string; retainedStepIds: string[] }>;
    orderChanges: Array<{ kind: 'project' | 'scene'; id: string; currentIds: string[]; restoredIds: string[] }>;
  };
  warnings: UndoWarning[];
};

export type RunSummary = {
  id: string;
  projectId: string;
  status: RunStatus;
  label?: string;
  startedAt: string;
  finishedAt: string | null;
  undoneAt: string | null;
  changes: {
    createdScenes: Array<{ id: string; name?: string; currentStatus: 'present' | 'deleted' }>;
    createdSteps: Array<{ id: string; sceneId: string; title?: string; currentStatus: 'present' | 'modified_after_run' | 'deleted' }>;
    modifiedSteps: Array<{ id: string; sceneId: string; title?: string; baselineRevision: string; runRevision: string; currentRevision: string | null; currentStatus: 'unchanged_since_run' | 'modified_concurrently' | 'modified_after_run' | 'deleted' }>;
    orderChanged: { project: boolean; sceneIds: string[] };
  };
  warnings: UndoWarning[];
};

const startRunInput = z.object({
  id: idSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
}).strict();

const undoRunInput = z.object({
  confirm: z.string().min(1).optional(),
  force: z.boolean().optional(),
}).strict();

export function runsDirectoryPath(dataDir: string, configured?: string) {
  const root = resolve(dataDir);
  const dir = resolve(configured ?? join(dirname(root), 'runs'));
  const rel = relative(root, dir);
  if (dir === root || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('Runs directory must be outside dataDir.');
  }
  return dir;
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

async function snapshotTree(store: Store, tree: ProjectTree, records: Map<string, RecordFile>): Promise<z.infer<typeof runSnapshotSchema>> {
  const projectRecord = records.get(`${tree.project.id}/project.json`)!;
  const scenes: z.infer<typeof runSnapshotSchema>['scenes'] = {};
  const steps: z.infer<typeof runSnapshotSchema>['steps'] = {};
  for (const { scene, steps: sceneSteps } of tree.scenes) {
    const sceneRecord = records.get(`${tree.project.id}/scenes/${scene.id}/scene.json`)!;
    scenes[scene.id] = { document: structuredClone(scene), revision: sceneRecord.revision };
    for (const step of sceneSteps) {
      const stepPath = `${tree.project.id}/scenes/${scene.id}/steps/${step.id}.json`;
      const stepRecord = records.get(stepPath)!;
      const rawBytes = await store.disk.read(stepPath);
      steps[step.id] = {
        sceneId: scene.id,
        document: structuredClone(step),
        revision: stepRecord.revision,
        rawText: rawBytes.toString('utf8'),
      };
    }
  }
  return {
    project: structuredClone(tree.project),
    projectRevision: projectRecord.revision,
    scenes,
    steps,
  };
}

function captureEndState(tree: ProjectTree, records: Map<string, RecordFile>): z.infer<typeof runEndStateSchema> {
  const scenes: z.infer<typeof runEndStateSchema>['scenes'] = {};
  const stepRevisions: Record<string, string> = {};
  for (const { scene, steps } of tree.scenes) {
    scenes[scene.id] = { name: scene.name, stepIds: [...scene.stepIds] };
    for (const step of steps) {
      const rec = records.get(`${tree.project.id}/scenes/${scene.id}/steps/${step.id}.json`);
      if (rec) stepRevisions[step.id] = rec.revision;
    }
  }
  return {
    projectSceneIds: [...tree.project.sceneIds],
    scenes,
    stepRevisions,
  };
}

function computeRestoredOrder(baselineOrder: string[], currentOrder: string[], removedIds: Set<string>): string[] {
  const currentKeep = currentOrder.filter((id) => !removedIds.has(id));
  const currentKeepSet = new Set(currentKeep);
  const baselineExisting = baselineOrder.filter((id) => currentKeepSet.has(id));
  const baselineSet = new Set(baselineExisting);
  const result = [...baselineExisting];
  for (let i = 0; i < currentKeep.length; i++) {
    const id = currentKeep[i];
    if (baselineSet.has(id)) continue;
    // Place post-run items right after their predecessor in currentKeep, or at the start.
    const prev = i > 0 ? currentKeep[i - 1] : undefined;
    const prevIdx = prev ? result.indexOf(prev) : -1;
    if (prevIdx >= 0) result.splice(prevIdx + 1, 0, id);
    else result.unshift(id);
  }
  return result;
}

export class RunStore {
  private activeRuns = new Map<string, StoredRun>();

  private constructor(
    private readonly dir: string,
    private readonly retentionLimit: number,
  ) {}

  static async create(dataDir: string, options: { runsDir?: string; retentionLimit?: number } = {}) {
    const dir = runsDirectoryPath(dataDir, options.runsDir);
    const retentionLimit = options.retentionLimit ?? DEFAULT_RUN_RETENTION_LIMIT;
    if (!Number.isInteger(retentionLimit) || retentionLimit < 1) {
      throw new Error('Run retentionLimit must be a positive integer.');
    }
    await mkdir(dir, { recursive: true });
    const runStore = new RunStore(dir, retentionLimit);
    await runStore.recoverInterruptedRuns();
    return runStore;
  }

  private async checkSafePath(targetPath: string) {
    const full = resolve(this.dir, targetPath);
    const rel = relative(this.dir, full);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new ApiError(400, 'INVALID_PATH', 'Run path leaves runs directory.');
    }
    let current = this.dir;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new ApiError(422, 'UNSAFE_PATH', 'Symbolic links are not supported in runs directory.');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return full;
  }

  private runFilePath(projectId: string, runId: string) {
    idSchema.parse(projectId);
    idSchema.parse(runId);
    return `${projectId}/${runId}.json`;
  }

  private async readRunFile(projectId: string, runId: string): Promise<StoredRun> {
    const full = await this.checkSafePath(this.runFilePath(projectId, runId));
    try {
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new ApiError(422, 'UNSAFE_PATH', 'Expected a regular run file.');
        const text = await handle.readFile('utf8');
        return storedRunSchema.parse(JSON.parse(text));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) throw new ApiError(404, 'NOT_FOUND', 'Run not found.');
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, 'INVALID_RUN', error instanceof Error ? error.message : 'Invalid stored run.');
    }
  }

  private async writeRunFile(run: StoredRun) {
    const relPath = this.runFilePath(run.projectId, run.id);
    const target = await this.checkSafePath(relPath);
    await mkdir(dirname(target), { recursive: true });
    await this.checkSafePath(relPath);
    const temp = join(dirname(target), `.paso-run-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.checkSafePath(relPath);
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async listProjectRunFiles(projectId: string): Promise<StoredRun[]> {
    idSchema.parse(projectId);
    const dir = await this.checkSafePath(projectId);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const runs: StoredRun[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      const runId = entry.name.slice(0, -5);
      if (!idSchema.safeParse(runId).success) continue;
      try {
        runs.push(await this.readRunFile(projectId, runId));
      } catch {
        // Ignore unreadable or corrupt non-active files during listing if any
      }
    }
    runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id));
    return runs;
  }

  private async recoverInterruptedRuns() {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success) continue;
      const projectId = entry.name;
      const runs = await this.listProjectRunFiles(projectId);
      for (const run of runs) {
        if (run.status === 'running') {
          run.status = 'interrupted';
          run.finishedAt = new Date().toISOString();
          await this.writeRunFile(run);
        }
      }
    }
  }

  private async pruneOldRuns(projectId: string) {
    const runs = await this.listProjectRunFiles(projectId);
    if (runs.length <= this.retentionLimit) return;
    // Keep any active run plus newest up to retentionLimit
    const toDelete = runs.slice(this.retentionLimit).filter((r) => r.status !== 'running');
    for (const run of toDelete) {
      const full = await this.checkSafePath(this.runFilePath(projectId, run.id));
      await rm(full, { force: true });
    }
  }

  async recordMutation(projectId: string, mutation: {
    action: 'createScene' | 'createStep' | 'duplicate' | 'updateStep' | 'orderScenes' | 'orderSteps' | 'rename' | 'delete';
    actor?: 'mcp' | 'user';
    sceneId?: string;
    stepId?: string;
    createdId?: string;
    previousRevision?: string;
    newRevision?: string;
    previousStep?: Step;
    newStep?: Step;
  }) {
    const active = this.activeRuns.get(projectId);
    if (!active || active.status !== 'running') return;
    let changed = false;
    if (mutation.action === 'createScene' && mutation.createdId) {
      if (!active.touched.createdScenes.includes(mutation.createdId)) {
        active.touched.createdScenes.push(mutation.createdId);
      }
      active.touched.reorderedProject = true;
      changed = true;
    } else if ((mutation.action === 'createStep' || mutation.action === 'duplicate') && mutation.createdId && mutation.sceneId) {
      active.touched.createdSteps[mutation.createdId] = mutation.sceneId;
      if (mutation.newRevision) {
        active.touched.touchedSteps[mutation.createdId] = {
          sceneId: mutation.sceneId,
          lastRevision: mutation.newRevision,
        };
      }
      if (!active.touched.reorderedScenes.includes(mutation.sceneId)) {
        active.touched.reorderedScenes.push(mutation.sceneId);
      }
      changed = true;
    } else if (mutation.action === 'updateStep' && mutation.stepId && mutation.sceneId && mutation.newRevision) {
      const existingTouch = active.touched.touchedSteps[mutation.stepId];
      const baseStep = active.baseline.steps[mutation.stepId];
      // Check if this step was already modified by a person during the run before this edit:
      // 1) An external edit happened before this API call (previousRevision !== expected lastRevision/baseline)
      const expectedPrevRev = existingTouch?.lastRevision ?? baseStep?.revision;
      const hadPriorExternalEdit = Boolean(expectedPrevRev && mutation.previousRevision && mutation.previousRevision !== expectedPrevRev);
      // 2) Both a user edit and an agent edit touched this step, or a user edited speakerNotes/title/appState/non-MCP fields after another edit during the run
      const prevHadConcurrent = Boolean(existingTouch?.hadConcurrentEdit);
      let isConcurrentHumanAndAgent = prevHadConcurrent || hadPriorExternalEdit;

      if (existingTouch && existingTouch.lastRevision !== (baseStep?.revision ?? '')) {
        // The step was already modified at least once during this run.
        // Check if one edit was human-authored (e.g., speakerNotes/title/appState changed or actor === 'user') and another was agent-authored.
        if (mutation.actor === 'user') {
          isConcurrentHumanAndAgent = true;
        }
      }

      active.touched.touchedSteps[mutation.stepId] = {
        sceneId: mutation.sceneId,
        lastRevision: mutation.newRevision,
        ...(isConcurrentHumanAndAgent ? { hadConcurrentEdit: true } : {}),
      };
      changed = true;
    } else if (mutation.action === 'orderScenes') {
      active.touched.reorderedProject = true;
      changed = true;
    } else if (mutation.action === 'orderSteps' && mutation.sceneId) {
      if (!active.touched.reorderedScenes.includes(mutation.sceneId)) {
        active.touched.reorderedScenes.push(mutation.sceneId);
      }
      changed = true;
    }
    if (changed) {
      await this.writeRunFile(active);
    }
  }

  async deleteProjectRuns(projectId: string) {
    this.activeRuns.delete(projectId);
    const full = await this.checkSafePath(projectId);
    await rm(full, { recursive: true, force: true });
  }

  async start(store: Store, projectId: string, input: unknown = {}): Promise<RunSummary> {
    const parsedInput = startRunInput.parse(input ?? {});
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const existingActive = this.activeRuns.get(projectId);
      if (existingActive && existingActive.status === 'running') {
        throw new ApiError(409, 'RUN_IN_PROGRESS', `Run "${existingActive.id}" is already in progress for this project.`);
      }
      const runId = parsedInput.id ?? randomUUID();
      const existingFile = await this.checkSafePath(this.runFilePath(projectId, runId));
      try {
        await lstat(existingFile);
        throw new ApiError(409, 'ALREADY_EXISTS', 'Run ID already exists.');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const now = new Date().toISOString();
      const baseline = await snapshotTree(store, tree, records);
      const run: StoredRun = {
        schemaVersion: 1,
        id: runId,
        projectId,
        status: 'running',
        ...(parsedInput.label ? { label: parsedInput.label } : {}),
        startedAt: now,
        finishedAt: null,
        undoneAt: null,
        baseline,
        touched: {
          createdScenes: [],
          createdSteps: {},
          touchedSteps: {},
          reorderedProject: false,
          reorderedScenes: [],
        },
      };
      await this.writeRunFile(run);
      this.activeRuns.set(projectId, run);
      await this.pruneOldRuns(projectId);
      return this.buildSummary(run, tree, records);
    });
  }

  async finish(store: Store, projectId: string, runId: string): Promise<RunSummary> {
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const run = this.activeRuns.get(projectId)?.id === runId
        ? this.activeRuns.get(projectId)!
        : await this.readRunFile(projectId, runId);
      if (run.status === 'undone') {
        throw new ApiError(409, 'RUN_ALREADY_UNDONE', 'Cannot finish a run that was already undone.');
      }
      if (run.status === 'running') {
        run.status = 'finished';
        run.finishedAt = new Date().toISOString();
        run.endState = captureEndState(tree, records);
        await this.writeRunFile(run);
        this.activeRuns.delete(projectId);
        await this.pruneOldRuns(projectId);
      }
      return this.buildSummary(run, tree, records);
    });
  }

  async list(store: Store, projectId: string): Promise<{ runs: RunSummary[] }> {
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const storedRuns = await this.listProjectRunFiles(projectId);
      return {
        runs: storedRuns.map((run) => this.buildSummary(run, tree, records)),
      };
    });
  }

  async get(store: Store, projectId: string, runId: string): Promise<{ run: RunSummary }> {
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const run = this.activeRuns.get(projectId)?.id === runId
        ? this.activeRuns.get(projectId)!
        : await this.readRunFile(projectId, runId);
      return { run: this.buildSummary(run, tree, records) };
    });
  }

  async previewUndo(store: Store, projectId: string, runId: string): Promise<{ plan: UndoPlan }> {
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const run = this.activeRuns.get(projectId)?.id === runId
        ? this.activeRuns.get(projectId)!
        : await this.readRunFile(projectId, runId);
      await this.assertCanAnalyzeOrUndo(projectId, run);
      const { plan } = this.computeUndo(run, tree, records);
      return { plan };
    });
  }

  async executeUndo(store: Store, projectId: string, runId: string, input: unknown = {}): Promise<{ run: RunSummary; plan: UndoPlan }> {
    const parsed = undoRunInput.parse(input ?? {});
    return store.withProjectLock(projectId, async ({ tree, records }) => {
      const run = this.activeRuns.get(projectId)?.id === runId
        ? this.activeRuns.get(projectId)!
        : await this.readRunFile(projectId, runId);
      await this.assertCanAnalyzeOrUndo(projectId, run);
      if (run.status === 'running') {
        throw new ApiError(409, 'RUN_IN_PROGRESS', 'Finish the run before undoing it.');
      }
      if (run.status === 'undone') {
        throw new ApiError(409, 'RUN_ALREADY_UNDONE', 'Run has already been undone.');
      }

      const { plan, nextTree } = this.computeUndo(run, tree, records);
      if (!parsed.confirm) {
        throw new ApiError(428, 'CONFIRMATION_REQUIRED', 'Preview the undo first and pass its confirmationToken in confirm.');
      }
      if (parsed.confirm !== plan.confirmationToken) {
        throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'Project state changed since the undo preview. Preview the undo again.');
      }
      if (plan.requiresForce && !parsed.force) {
        throw new ApiError(409, 'FORCE_REQUIRED', 'Undoing this run will overwrite human edits. Set force: true to confirm.');
      }

      const changedSomething =
        plan.changes.stepsToRestore.length > 0 ||
        plan.changes.stepsToRecreate.length > 0 ||
        plan.changes.stepsToDelete.length > 0 ||
        plan.changes.scenesToDelete.length > 0 ||
        plan.changes.orderChanges.length > 0;

      if (changedSomething) {
        const rawOverrides = new Map<string, Uint8Array>();
        for (const item of [...plan.changes.stepsToRestore, ...plan.changes.stepsToRecreate]) {
          const rawText = run.baseline.steps[item.id]?.rawText;
          if (rawText !== undefined) {
            rawOverrides.set(`${projectId}/scenes/${item.sceneId}/steps/${item.id}.json`, Buffer.from(rawText, 'utf8'));
          }
        }
        await store.applyTree(projectId, nextTree, records, rawOverrides);
      }

      run.status = 'undone';
      run.undoneAt = new Date().toISOString();
      if (!run.finishedAt) run.finishedAt = run.undoneAt;
      await this.writeRunFile(run);
      this.activeRuns.delete(projectId);

      const refreshed = await store.loadTree(projectId);
      return {
        run: this.buildSummary(run, refreshed.tree, refreshed.records),
        plan,
      };
    });
  }

  private async assertCanAnalyzeOrUndo(projectId: string, run: StoredRun) {
    const active = this.activeRuns.get(projectId);
    if (active && active.status === 'running' && active.id !== run.id) {
      throw new ApiError(409, 'RUN_IN_PROGRESS', `Another run ("${active.id}") is currently in progress.`);
    }
    const allRuns = await this.listProjectRunFiles(projectId);
    const newerActiveRuns = allRuns.filter((other) =>
      other.id !== run.id &&
      other.status !== 'undone' &&
      (Date.parse(other.startedAt) > Date.parse(run.startedAt)),
    );
    if (newerActiveRuns.length > 0) {
      throw new ApiError(
        409,
        'NEWER_RUN_EXISTS',
        `Cannot undo run "${run.id}" while newer run "${newerActiveRuns[0].id}" has not been undone.`,
      );
    }
  }

  private deriveRunChanges(run: StoredRun, tree: ProjectTree) {
    const currentScenes = new Map<string, { scene: Scene; steps: Map<string, Step> }>();
    for (const { scene, steps } of tree.scenes) {
      currentScenes.set(scene.id, { scene, steps: new Map(steps.map((s) => [s.id, s])) });
    }

    // Created scenes: recorded in touched.createdScenes, or if interrupted/finished, any scene in endState not in baseline
    const createdSceneIds = new Set<string>(run.touched.createdScenes);
    if (run.endState) {
      for (const sceneId of Object.keys(run.endState.scenes)) {
        if (!Object.hasOwn(run.baseline.scenes, sceneId)) createdSceneIds.add(sceneId);
      }
    } else {
      for (const { scene } of tree.scenes) {
        if (!Object.hasOwn(run.baseline.scenes, scene.id) && run.touched.createdScenes.includes(scene.id)) {
          createdSceneIds.add(scene.id);
        }
      }
    }

    // Created steps: recorded in touched.createdSteps
    const createdStepsMap = new Map<string, string>(Object.entries(run.touched.createdSteps));
    if (run.endState) {
      for (const [sceneId, sceneEnd] of Object.entries(run.endState.scenes)) {
        for (const stepId of sceneEnd.stepIds) {
          if (!Object.hasOwn(run.baseline.steps, stepId) && run.touched.createdSteps[stepId]) {
            createdStepsMap.set(stepId, sceneId);
          }
        }
      }
    }

    // Modified baseline steps: baseline steps that the run touched
    const modifiedBaselineSteps = new Map<string, { sceneId: string; baselineRevision: string; runRevision: string; hadConcurrentEdit: boolean }>();
    for (const [stepId, baseStep] of Object.entries(run.baseline.steps)) {
      const touched = run.touched.touchedSteps[stepId];
      if (touched && touched.lastRevision !== baseStep.revision) {
        modifiedBaselineSteps.set(stepId, {
          sceneId: baseStep.sceneId,
          baselineRevision: baseStep.revision,
          runRevision: touched.lastRevision,
          hadConcurrentEdit: Boolean(touched.hadConcurrentEdit),
        });
      }
    }

    return { currentScenes, createdSceneIds, createdStepsMap, modifiedBaselineSteps };
  }

  private buildSummary(run: StoredRun, tree: ProjectTree, records: Map<string, RecordFile>): RunSummary {
    const { currentScenes, createdSceneIds, createdStepsMap, modifiedBaselineSteps } = this.deriveRunChanges(run, tree);
    const { plan } = this.computeUndo(run, tree, records);

    const createdScenes = [...createdSceneIds].map((id) => {
      const curr = currentScenes.get(id)?.scene;
      const endName = run.endState?.scenes[id]?.name;
      return {
        id,
        ...(curr?.name ?? endName ? { name: curr?.name ?? endName } : {}),
        currentStatus: curr ? ('present' as const) : ('deleted' as const),
      };
    });

    const createdSteps = [...createdStepsMap.entries()].map(([id, sceneId]) => {
      const currStep = currentScenes.get(sceneId)?.steps.get(id);
      const rec = records.get(`${run.projectId}/scenes/${sceneId}/steps/${id}.json`);
      const lastRunRev = run.touched.touchedSteps[id]?.lastRevision ?? run.endState?.stepRevisions[id];
      const status: 'present' | 'modified_after_run' | 'deleted' = !currStep || !rec
        ? 'deleted'
        : lastRunRev && rec.revision !== lastRunRev
          ? 'modified_after_run'
          : 'present';
      return {
        id,
        sceneId,
        ...(currStep?.title ? { title: currStep.title } : {}),
        currentStatus: status,
      };
    });

    const modifiedSteps = [...modifiedBaselineSteps.entries()].map(([id, info]) => {
      const baseDoc = run.baseline.steps[id].document;
      const currStep = currentScenes.get(info.sceneId)?.steps.get(id);
      const rec = records.get(`${run.projectId}/scenes/${info.sceneId}/steps/${id}.json`);
      const endRev = run.endState?.stepRevisions[id];
      let currentStatus: 'unchanged_since_run' | 'modified_concurrently' | 'modified_after_run' | 'deleted';
      if (!currStep || !rec) {
        currentStatus = 'deleted';
      } else if (rec.revision !== info.runRevision) {
        if (endRev && endRev !== info.runRevision && rec.revision === endRev) {
          currentStatus = 'modified_concurrently';
        } else {
          currentStatus = 'modified_after_run';
        }
      } else if (info.hadConcurrentEdit) {
        currentStatus = 'modified_concurrently';
      } else {
        currentStatus = 'unchanged_since_run';
      }
      return {
        id,
        sceneId: info.sceneId,
        ...(currStep?.title ?? baseDoc.title ? { title: currStep?.title ?? baseDoc.title } : {}),
        baselineRevision: info.baselineRevision,
        runRevision: info.runRevision,
        currentRevision: rec?.revision ?? null,
        currentStatus,
      };
    });

    return {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      ...(run.label ? { label: run.label } : {}),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      undoneAt: run.undoneAt,
      changes: {
        createdScenes,
        createdSteps,
        modifiedSteps,
        orderChanged: {
          project: run.touched.reorderedProject,
          sceneIds: [...run.touched.reorderedScenes],
        },
      },
      warnings: plan.warnings,
    };
  }

  private computeUndo(run: StoredRun, tree: ProjectTree, records: Map<string, RecordFile>): { plan: UndoPlan; nextTree: ProjectTree } {
    const { currentScenes, createdSceneIds, createdStepsMap, modifiedBaselineSteps } = this.deriveRunChanges(run, tree);

    const warnings: UndoWarning[] = [];
    const stepsToRestore: UndoPlan['changes']['stepsToRestore'] = [];
    const stepsToRecreate: UndoPlan['changes']['stepsToRecreate'] = [];
    const stepsToDelete: UndoPlan['changes']['stepsToDelete'] = [];
    const scenesToDelete: UndoPlan['changes']['scenesToDelete'] = [];
    const scenesToKeepWithPostRunSteps: UndoPlan['changes']['scenesToKeepWithPostRunSteps'] = [];
    const orderChanges: UndoPlan['changes']['orderChanges'] = [];

    let requiresForce = false;

    // 1. Evaluate modified baseline steps
    const stepsToRestoreDocs = new Map<string, Step>();
    const stepsToRecreateDocs = new Map<string, { sceneId: string; step: Step }>();

    for (const [stepId, info] of modifiedBaselineSteps) {
      const baseEntry = run.baseline.steps[stepId];
      const currScene = currentScenes.get(info.sceneId);
      const currStep = currScene?.steps.get(stepId);
      const rec = records.get(`${run.projectId}/scenes/${info.sceneId}/steps/${stepId}.json`);
      const title = currStep?.title ?? baseEntry.document.title;

      if (!currScene) {
        warnings.push({
          code: 'SCENE_DELETED',
          kind: 'scene',
          id: info.sceneId,
          message: `Scene "${info.sceneId}" containing modified step "${stepId}" was deleted; skipping step restore.`,
        });
        continue;
      }

      if (!currStep || !rec) {
        requiresForce = true;
        warnings.push({
          code: 'STEP_DELETED',
          kind: 'step',
          id: stepId,
          sceneId: info.sceneId,
          ...(title ? { title } : {}),
          message: `Step "${stepId}" was modified by the run and later deleted by a person. Undoing will recreate its baseline snapshot.`,
        });
        stepsToRecreate.push({
          id: stepId,
          sceneId: info.sceneId,
          ...(title ? { title } : {}),
          restoreRevision: baseEntry.revision,
        });
        stepsToRecreateDocs.set(stepId, { sceneId: info.sceneId, step: structuredClone(baseEntry.document) });
        continue;
      }

      const endRev = run.endState?.stepRevisions[stepId];
      if (rec.revision !== info.runRevision) {
        requiresForce = true;
        if (endRev && endRev !== info.runRevision && rec.revision === endRev) {
          warnings.push({
            code: 'STEP_MODIFIED_CONCURRENTLY',
            kind: 'step',
            id: stepId,
            sceneId: info.sceneId,
            ...(title ? { title } : {}),
            message: `Step "${stepId}" was edited during the run outside the run's recorded writes. Restoring the snapshot will also revert those human edits.`,
          });
        } else {
          warnings.push({
            code: 'STEP_MODIFIED_AFTER_RUN',
            kind: 'step',
            id: stepId,
            sceneId: info.sceneId,
            ...(title ? { title } : {}),
            message: `Step "${stepId}" was edited after the run finished. Restoring the snapshot will overwrite those human edits.`,
          });
        }
      } else if (info.hadConcurrentEdit) {
        requiresForce = true;
        warnings.push({
          code: 'STEP_MODIFIED_CONCURRENTLY',
          kind: 'step',
          id: stepId,
          sceneId: info.sceneId,
          ...(title ? { title } : {}),
          message: `Step "${stepId}" was edited by both the run and a person during the run. Restoring the baseline snapshot will also revert the person's edits to this step.`,
        });
      }

      if (rec.revision !== baseEntry.revision) {
        stepsToRestore.push({
          id: stepId,
          sceneId: info.sceneId,
          ...(title ? { title } : {}),
          currentRevision: rec.revision,
          restoreRevision: baseEntry.revision,
        });
        stepsToRestoreDocs.set(stepId, structuredClone(baseEntry.document));
      }
    }

    // 2. Evaluate steps created by the run
    const stepIdsToRemove = new Set<string>();
    for (const [stepId, sceneId] of createdStepsMap) {
      const currScene = currentScenes.get(sceneId);
      const currStep = currScene?.steps.get(stepId);
      const rec = records.get(`${run.projectId}/scenes/${sceneId}/steps/${stepId}.json`);
      if (!currScene || !currStep || !rec) {
        // Already deleted by user; no action needed
        continue;
      }
      const title = currStep.title;
      const expectedRev = run.touched.touchedSteps[stepId]?.lastRevision ?? run.endState?.stepRevisions[stepId];
      if (expectedRev && rec.revision !== expectedRev) {
        requiresForce = true;
        warnings.push({
          code: 'STEP_MODIFIED_AFTER_RUN',
          kind: 'step',
          id: stepId,
          sceneId,
          ...(title ? { title } : {}),
          message: `Step "${stepId}" was created by the run and later edited by a person. Undoing will delete this step and lose those edits.`,
        });
      }
      stepIdsToRemove.add(stepId);
      stepsToDelete.push({
        id: stepId,
        sceneId,
        ...(title ? { title } : {}),
        currentRevision: rec.revision,
      });
    }

    // 3. Evaluate scenes created by the run
    const sceneIdsToRemove = new Set<string>();
    for (const sceneId of createdSceneIds) {
      const currScene = currentScenes.get(sceneId);
      const rec = records.get(`${run.projectId}/scenes/${sceneId}/scene.json`);
      if (!currScene || !rec) {
        continue;
      }
      const remainingStepIds = currScene.scene.stepIds.filter((id) => !stepIdsToRemove.has(id));
      if (remainingStepIds.length > 0) {
        warnings.push({
          code: 'SCENE_HAS_POST_RUN_STEPS',
          kind: 'scene',
          id: sceneId,
          message: `Scene "${sceneId}" created by the run now contains human-created steps (${remainingStepIds.join(', ')}); keeping the scene and those steps.`,
        });
        scenesToKeepWithPostRunSteps.push({
          id: sceneId,
          name: currScene.scene.name,
          retainedStepIds: remainingStepIds,
        });
      } else {
        sceneIdsToRemove.add(sceneId);
        scenesToDelete.push({
          id: sceneId,
          name: currScene.scene.name,
          currentRevision: rec.revision,
        });
      }
    }

    // 4. Construct nextTree and evaluate order restorations
    const nextProject: Project = structuredClone(tree.project);
    const nextScenes: Array<{ scene: Scene; steps: Step[] }> = [];

    for (const { scene, steps } of tree.scenes) {
      if (sceneIdsToRemove.has(scene.id)) continue;
      const nextScene = structuredClone(scene);
      const nextSteps: Step[] = [];
      for (const step of steps) {
        if (stepIdsToRemove.has(step.id)) continue;
        if (stepsToRestoreDocs.has(step.id)) {
          nextSteps.push(stepsToRestoreDocs.get(step.id)!);
        } else {
          nextSteps.push(structuredClone(step));
        }
      }
      // Add recreated steps if any belong to this scene
      for (const [, recreate] of stepsToRecreateDocs) {
        if (recreate.sceneId === scene.id) {
          nextSteps.push(recreate.step);
        }
      }

      const currentOrderAfterRemovals = nextScene.stepIds.filter((id) => !stepIdsToRemove.has(id));
      for (const [stepId, recreate] of stepsToRecreateDocs) {
        if (recreate.sceneId === scene.id && !currentOrderAfterRemovals.includes(stepId)) {
          currentOrderAfterRemovals.push(stepId);
        }
      }

      const baseScene = run.baseline.scenes[scene.id];
      const runTouchedSceneOrder = run.touched.reorderedScenes.includes(scene.id) ||
        stepsToRecreate.some((s) => s.sceneId === scene.id);

      if (baseScene && runTouchedSceneOrder) {
        const endOrder = run.endState?.scenes[scene.id]?.stepIds;
        if (endOrder && !sameIds(scene.stepIds, endOrder)) {
          warnings.push({
            code: 'ORDER_MODIFIED_AFTER_RUN',
            kind: 'scene',
            id: scene.id,
            sceneId: scene.id,
            message: `Step order in scene "${scene.id}" was changed after the run.`,
          });
        }
        const restoredStepIds = computeRestoredOrder(baseScene.document.stepIds, currentOrderAfterRemovals, stepIdsToRemove);
        if (!sameIds(scene.stepIds, restoredStepIds)) {
          orderChanges.push({
            kind: 'scene',
            id: scene.id,
            currentIds: [...scene.stepIds],
            restoredIds: restoredStepIds,
          });
        }
        nextScene.stepIds = restoredStepIds;
      } else {
        if (!sameIds(scene.stepIds, currentOrderAfterRemovals)) {
          orderChanges.push({
            kind: 'scene',
            id: scene.id,
            currentIds: [...scene.stepIds],
            restoredIds: currentOrderAfterRemovals,
          });
        }
        nextScene.stepIds = currentOrderAfterRemovals;
      }

      // Order steps array to match nextScene.stepIds
      const stepMap = new Map(nextSteps.map((s) => [s.id, s]));
      nextScenes.push({
        scene: nextScene,
        steps: nextScene.stepIds.map((id) => stepMap.get(id)!),
      });
    }

    const currentProjectOrderAfterRemovals = nextProject.sceneIds.filter((id) => !sceneIdsToRemove.has(id));
    if (run.touched.reorderedProject) {
      const endSceneOrder = run.endState?.projectSceneIds;
      if (endSceneOrder && !sameIds(tree.project.sceneIds, endSceneOrder)) {
        warnings.push({
          code: 'ORDER_MODIFIED_AFTER_RUN',
          kind: 'project',
          id: tree.project.id,
          message: `Scene order in project "${tree.project.id}" was changed after the run.`,
        });
      }
      const restoredSceneIds = computeRestoredOrder(run.baseline.project.sceneIds, currentProjectOrderAfterRemovals, sceneIdsToRemove);
      if (!sameIds(tree.project.sceneIds, restoredSceneIds)) {
        orderChanges.push({
          kind: 'project',
          id: tree.project.id,
          currentIds: [...tree.project.sceneIds],
          restoredIds: restoredSceneIds,
        });
      }
      nextProject.sceneIds = restoredSceneIds;
    } else {
      if (!sameIds(tree.project.sceneIds, currentProjectOrderAfterRemovals)) {
        orderChanges.push({
          kind: 'project',
          id: tree.project.id,
          currentIds: [...tree.project.sceneIds],
          restoredIds: currentProjectOrderAfterRemovals,
        });
      }
      nextProject.sceneIds = currentProjectOrderAfterRemovals;
    }

    const sceneMap = new Map(nextScenes.map((entry) => [entry.scene.id, entry]));
    const orderedNextScenes = nextProject.sceneIds.map((id) => sceneMap.get(id)!);
    const nextTree: ProjectTree = validateProjectTree({
      project: nextProject,
      scenes: orderedNextScenes,
    });

    const changesPayload = {
      stepsToRestore,
      stepsToRecreate,
      stepsToDelete,
      scenesToDelete,
      scenesToKeepWithPostRunSteps,
      orderChanges,
    };

    const currentRevisions = [...records.entries()]
      .filter(([, r]) => r.kind !== 'asset')
      .map(([path, r]) => [path, r.revision] as const)
      .sort(([a], [b]) => a.localeCompare(b));

    const confirmationToken = createHash('sha256')
      .update(JSON.stringify({
        runId: run.id,
        projectId: run.projectId,
        requiresForce,
        changes: changesPayload,
        warnings,
        currentRevisions,
      }))
      .digest('hex');

    const plan: UndoPlan = {
      runId: run.id,
      projectId: run.projectId,
      status: run.status,
      canUndo: run.status === 'finished' || run.status === 'interrupted',
      requiresForce,
      confirmationToken,
      changes: changesPayload,
      warnings,
    };

    return { plan, nextTree };
  }
}
