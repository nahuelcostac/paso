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
    deletedByRun: z.boolean().optional(),
  }).strict()),
  humanEditedSteps: z.record(idSchema, z.string()).optional(),
  deletedScenes: z.array(idSchema).optional(),
  humanChangedScenes: z.array(idSchema).optional(),
  humanReorderedProject: z.boolean().optional(),
  humanReorderedScenes: z.array(idSchema).optional(),
  projectOrderBaseline: z.array(idSchema).optional(),
  sceneOrderBaselines: z.record(idSchema, z.array(idSchema)).optional(),
  reorderedProject: z.boolean(),
  reorderedScenes: z.array(idSchema),
}).strict();

const storedRunSchema = z.object({
  schemaVersion: z.literal(1),
  attributionVersion: z.literal(2).optional(),
  observedState: runEndStateSchema.optional(),
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
  code: 'STEP_MODIFIED_CONCURRENTLY' | 'STEP_MODIFIED_AFTER_RUN' | 'STEP_DELETED' | 'SCENE_DELETED' | 'SCENE_HAS_POST_RUN_STEPS' | 'ORDER_MODIFIED_AFTER_RUN' | 'ORDER_MODIFIED_CONCURRENTLY' | 'SCENE_MODIFIED_CONCURRENTLY' | 'SCENE_MODIFIED_AFTER_RUN';
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
    scenesToRecreate: Array<{ id: string; name: string }>;
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

function relativeOrderChanged(a: string[], b: string[]) {
  const shared = new Set(a.filter((id) => b.includes(id)));
  return !sameIds(a.filter((id) => shared.has(id)), b.filter((id) => shared.has(id)));
}

/** Restore deleted items beside a surviving baseline neighbour, preserving all live order. */
function insertRestoredIds(baseline: string[], current: string[], restored: Set<string>) {
  const result = current.filter((id) => !restored.has(id));
  for (const id of baseline.filter((id) => restored.has(id))) {
    const index = baseline.indexOf(id);
    const next = baseline.slice(index + 1).find((other) => result.includes(other));
    if (next) result.splice(result.indexOf(next), 0, id);
    else result.push(id);
  }
  return result;
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

  hasActiveRun(projectId: string) { return this.activeRuns.has(projectId); }

  /** Track unmediated disk edits before a service operation, under the project lock. */
  async observeState(store: Store, tree: ProjectTree, records: Map<string, RecordFile>) {
    const run = this.activeRuns.get(tree.project.id);
    if (!run) return;
    const current = captureEndState(tree, records);
    const previous = run.observedState;
    let changed = JSON.stringify(previous) !== JSON.stringify(current);
    if (previous) this.recordHumanDifferences(run, previous, current);
    // A person can create an item, then the agent can edit or delete it. Keep its
    // first observed snapshot without classifying its creation as an agent write.
    for (const { scene, steps } of tree.scenes) {
      if (!run.baseline.scenes[scene.id] && !run.touched.createdScenes.includes(scene.id)) {
        const revision = records.get(`${run.projectId}/scenes/${scene.id}/scene.json`)!.revision;
        run.baseline.scenes[scene.id] = { document: structuredClone(scene), revision };
        changed = true;
      }
      for (const step of steps) {
        if (run.baseline.steps[step.id] || run.touched.createdSteps[step.id]) continue;
        const path = `${run.projectId}/scenes/${scene.id}/steps/${step.id}.json`;
        run.baseline.steps[step.id] = {
          sceneId: scene.id, document: structuredClone(step), revision: records.get(path)!.revision,
          rawText: (await store.disk.read(path)).toString('utf8'),
        };
        changed = true;
      }
    }
    run.observedState = current;
    if (changed) await this.writeRunFile(run);
  }

  private recordHumanDifferences(run: StoredRun, before: z.infer<typeof runEndStateSchema>, after: z.infer<typeof runEndStateSchema>) {
    const human = run.touched.humanEditedSteps ??= {};
    for (const id of new Set([...Object.keys(before.stepRevisions), ...Object.keys(after.stepRevisions)])) {
      if (before.stepRevisions[id] !== after.stepRevisions[id]) human[id] = after.stepRevisions[id] ?? 'deleted';
    }
    for (const id of new Set([...Object.keys(before.scenes), ...Object.keys(after.scenes)])) {
      if (before.scenes[id]?.name !== after.scenes[id]?.name) {
        const changed = run.touched.humanChangedScenes ??= [];
        if (!changed.includes(id)) changed.push(id);
      }
    }
    // Additions and deletions alone do not reorder surviving items.
    if (relativeOrderChanged(before.projectSceneIds, after.projectSceneIds)) run.touched.humanReorderedProject = true;
    for (const [id, scene] of Object.entries(before.scenes)) {
      if (after.scenes[id] && relativeOrderChanged(scene.stepIds, after.scenes[id].stepIds)) {
        const reordered = run.touched.humanReorderedScenes ??= [];
        if (!reordered.includes(id)) reordered.push(id);
      }
    }
  }

  async recordMutation(actor: 'mcp' | 'user', action: string, before: Map<string, RecordFile>, tree: ProjectTree, records: Map<string, RecordFile>, sceneId?: string) {
    const run = this.activeRuns.get(tree.project.id);
    if (!run) return;
    const current = captureEndState(tree, records);
    if (actor === 'user') {
      this.recordHumanDifferences(run, run.observedState!, current);
    } else {
      for (const [path, record] of records) {
        if (record.kind === 'scene' && !before.has(path) && !run.baseline.scenes[record.id]) {
          if (!run.touched.createdScenes.includes(record.id)) run.touched.createdScenes.push(record.id);
        }
        if (record.kind !== 'step' || before.get(path)?.revision === record.revision) continue;
        if (!before.has(path) && !run.baseline.steps[record.id]) run.touched.createdSteps[record.id] = record.sceneId!;
        run.touched.touchedSteps[record.id] = {
          sceneId: record.sceneId!, lastRevision: record.revision,
          hadConcurrentEdit: Boolean(run.touched.humanEditedSteps?.[record.id]),
        };
      }
      for (const [path, record] of before) {
        if (records.has(path)) continue;
        if (record.kind === 'step') {
          run.touched.touchedSteps[record.id] = {
            sceneId: record.sceneId!, lastRevision: record.revision, deletedByRun: true,
            hadConcurrentEdit: Boolean(run.touched.humanEditedSteps?.[record.id]),
          };
        } else if (record.kind === 'scene' && !run.touched.createdScenes.includes(record.id)) {
          const deleted = run.touched.deletedScenes ??= [];
          if (!deleted.includes(record.id)) deleted.push(record.id);
        }
      }
      const previous = run.observedState!;
      if (action === 'orderScenes' && relativeOrderChanged(previous.projectSceneIds, current.projectSceneIds)) {
        run.touched.projectOrderBaseline ??= computeRestoredOrder(run.baseline.project.sceneIds, previous.projectSceneIds, new Set());
        run.touched.reorderedProject = true;
      }
      if (action === 'orderSteps' && sceneId && relativeOrderChanged(previous.scenes[sceneId].stepIds, current.scenes[sceneId].stepIds)) {
        const baselines = run.touched.sceneOrderBaselines ??= {};
        baselines[sceneId] ??= computeRestoredOrder(run.baseline.scenes[sceneId]?.document.stepIds ?? previous.scenes[sceneId].stepIds, previous.scenes[sceneId].stepIds, new Set());
        if (!run.touched.reorderedScenes.includes(sceneId)) run.touched.reorderedScenes.push(sceneId);
      }
    }
    run.observedState = current;
    await this.writeRunFile(run);
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
        attributionVersion: 2,
        observedState: captureEndState(tree, records),
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
        plan.changes.scenesToRecreate.length > 0 ||
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
    if (run.attributionVersion !== 2) {
      throw new ApiError(409, 'RUN_ATTRIBUTION_UNKNOWN', 'This restore point predates reliable write attribution and cannot be undone safely.');
    }
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

    const createdSceneIds = new Set<string>(run.touched.createdScenes);
    const createdStepsMap = new Map<string, string>(Object.entries(run.touched.createdSteps));

    // Modified baseline steps: baseline steps that the run touched
    const modifiedBaselineSteps = new Map<string, { sceneId: string; baselineRevision: string; runRevision: string; hadConcurrentEdit: boolean }>();
    for (const [stepId, baseStep] of Object.entries(run.baseline.steps)) {
      const touched = run.touched.touchedSteps[stepId];
      if (touched && (touched.deletedByRun || touched.lastRevision !== baseStep.revision || run.touched.humanEditedSteps?.[stepId])) {
        modifiedBaselineSteps.set(stepId, {
          sceneId: baseStep.sceneId,
          baselineRevision: baseStep.revision,
          runRevision: touched.lastRevision,
          hadConcurrentEdit: Boolean(touched.hadConcurrentEdit || run.touched.humanEditedSteps?.[stepId]),
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
        if (info.hadConcurrentEdit && (!endRev || rec.revision === endRev)) {
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
    // Recreate only scenes deleted by the agent. Human-deleted scenes stay deleted.
    const scenesToRecreate: UndoPlan['changes']['scenesToRecreate'] = [];
    const workingTree = structuredClone(tree);
    for (const id of run.touched.deletedScenes ?? []) {
      if (currentScenes.has(id)) continue;
      const baseline = run.baseline.scenes[id];
      if (!baseline) continue;
      const scene = { ...structuredClone(baseline.document), stepIds: [] as string[] };
      workingTree.scenes.push({ scene, steps: [] });
      workingTree.project.sceneIds.push(id);
      currentScenes.set(id, { scene, steps: new Map() });
      scenesToRecreate.push({ id, name: scene.name });
    }
    workingTree.project.sceneIds = insertRestoredIds(run.baseline.project.sceneIds, workingTree.project.sceneIds, new Set(scenesToRecreate.map((s) => s.id)));

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
        if (!run.touched.touchedSteps[stepId]?.deletedByRun || info.hadConcurrentEdit) {
          requiresForce = true;
          warnings.push({
            code: 'STEP_DELETED', kind: 'step', id: stepId, sceneId: info.sceneId,
            ...(title ? { title } : {}),
            message: `Step "${stepId}" was edited or deleted by both the run and a person. Undoing will recreate its baseline snapshot and revert the person's changes.`,
          });
        }
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
        if (info.hadConcurrentEdit && (!endRev || rec.revision === endRev)) {
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
      const humanDuringRun = Boolean(run.touched.humanEditedSteps?.[stepId]);
      if (humanDuringRun || (expectedRev && rec.revision !== expectedRev)) {
        requiresForce = true;
        warnings.push({
          code: humanDuringRun ? 'STEP_MODIFIED_CONCURRENTLY' : 'STEP_MODIFIED_AFTER_RUN',
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
        const humanDuringRun = run.touched.humanChangedScenes?.includes(sceneId);
        const expectedName = run.observedState?.scenes[sceneId]?.name;
        if (humanDuringRun || (expectedName !== undefined && expectedName !== currScene.scene.name)) {
          requiresForce = true;
          warnings.push({
            code: humanDuringRun ? 'SCENE_MODIFIED_CONCURRENTLY' : 'SCENE_MODIFIED_AFTER_RUN',
            kind: 'scene', id: sceneId,
            message: `Scene "${sceneId}" was created by the run and edited by a person. Undoing will delete the scene and lose those edits.`,
          });
        }
        sceneIdsToRemove.add(sceneId);
        scenesToDelete.push({
          id: sceneId,
          name: currScene.scene.name,
          currentRevision: rec.revision,
        });
      }
    }

    // 4. Construct nextTree and evaluate order restorations
    const nextProject: Project = structuredClone(workingTree.project);
    const nextScenes: Array<{ scene: Scene; steps: Step[] }> = [];

    for (const { scene, steps } of workingTree.scenes) {
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
      const runTouchedSceneOrder = run.touched.reorderedScenes.includes(scene.id);
      if (!runTouchedSceneOrder && baseScene) {
        const recreated = new Set([...stepsToRecreateDocs].filter(([, value]) => value.sceneId === scene.id).map(([id]) => id));
        const placed = insertRestoredIds(baseScene.document.stepIds, currentOrderAfterRemovals, recreated);
        currentOrderAfterRemovals.splice(0, currentOrderAfterRemovals.length, ...placed);
      }

      const baselineOrder = run.touched.sceneOrderBaselines?.[scene.id] ?? baseScene?.document.stepIds;
      if (baselineOrder && runTouchedSceneOrder) {
        const endOrder = (run.endState ?? run.observedState)?.scenes[scene.id]?.stepIds;
        const humanDuringRun = run.touched.humanReorderedScenes?.includes(scene.id);
        if (humanDuringRun || (endOrder && relativeOrderChanged(scene.stepIds, endOrder))) {
          requiresForce = true;
          warnings.push({
            code: humanDuringRun ? 'ORDER_MODIFIED_CONCURRENTLY' : 'ORDER_MODIFIED_AFTER_RUN',
            kind: 'scene',
            id: scene.id,
            sceneId: scene.id,
            message: `Restoring step order in scene "${scene.id}" will also revert a person's order changes.`,
          });
        }
        const restoredStepIds = computeRestoredOrder(baselineOrder, currentOrderAfterRemovals, stepIdsToRemove);
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
      const endSceneOrder = (run.endState ?? run.observedState)?.projectSceneIds;
      const humanDuringRun = run.touched.humanReorderedProject;
      if (humanDuringRun || (endSceneOrder && relativeOrderChanged(tree.project.sceneIds, endSceneOrder))) {
        requiresForce = true;
        warnings.push({
          code: humanDuringRun ? 'ORDER_MODIFIED_CONCURRENTLY' : 'ORDER_MODIFIED_AFTER_RUN',
          kind: 'project',
          id: tree.project.id,
          message: `Restoring scene order in project "${tree.project.id}" will also revert a person's order changes.`,
        });
      }
      const restoredSceneIds = computeRestoredOrder(run.touched.projectOrderBaseline ?? run.baseline.project.sceneIds, currentProjectOrderAfterRemovals, sceneIdsToRemove);
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
      scenesToRecreate,
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
