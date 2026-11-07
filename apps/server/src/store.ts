import { watch, type FSWatcher } from 'node:fs';
import {
  createProject, createScene, createStep, duplicateStep, idSchema, parseProject, parseScene, parseStep,
  validateProjectTree, stepSchema, iconNameSchema, type ProjectTree, type Step,
} from '@paso/shared';
import { z } from 'zod';
import { Disk, assetName, hash, jsonBytes, type Document, type RecordFile } from './disk.js';
import { ApiError } from './errors.js';
import type { RunStore } from './runs.js';

export type ChangeEvent = {
  type: 'created' | 'updated' | 'deleted' | 'reordered' | 'project-error';
  projectId: string; kind: RecordFile['kind']; id: string; sceneId?: string;
  revision: string | null; previousRevision?: string; message?: string;
};
export type Envelope = { document: Document; revision: string };
const namedInput = z.object({ id: idSchema.optional(), name: z.string().min(1) }).strict();
const renameInput = z.object({ name: z.string().min(1) }).strict();
const projectCreateInput = z.object({ id: idSchema.optional(), name: z.string().min(1), icon: iconNameSchema.optional() }).strict();
// A project can be renamed, given an icon, or both. A null icon removes it.
const projectPatchInput = z.object({ name: z.string().min(1).optional(), icon: iconNameSchema.nullable().optional() }).strict()
  .refine((data) => data.name !== undefined || data.icon !== undefined, { message: 'Send a name, an icon, or both.' });
const orderInput = z.object({ ids: z.array(idSchema) }).strict();
const stepInput = stepSchema.omit({ schemaVersion: true }).partial().strict();
const duplicateInput = z.object({ id: idSchema.optional() }).strict();
const projectPath = (id: string) => `${id}/project.json`;
const scenePath = (p: string, s: string) => `${p}/scenes/${s}/scene.json`;
const stepPath = (p: string, s: string, t: string) => `${p}/scenes/${s}/steps/${t}.json`;
const envelope = (record: RecordFile): Envelope => ({ document: record.document!, revision: record.revision });

function documents(tree: ProjectTree) {
  const result = new Map<string, Document>([[projectPath(tree.project.id), tree.project]]);
  for (const { scene, steps } of tree.scenes) {
    result.set(scenePath(tree.project.id, scene.id), scene);
    for (const step of steps) result.set(stepPath(tree.project.id, scene.id, step.id), step);
  }
  return result;
}
function changedOrder(before: RecordFile, after: RecordFile) {
  const a = before.document, b = after.document;
  if (!a || !b) return false;
  if ('sceneIds' in a && 'sceneIds' in b) return JSON.stringify(a.sceneIds) !== JSON.stringify(b.sceneIds);
  if ('stepIds' in a && 'stepIds' in b) return JSON.stringify(a.stepIds) !== JSON.stringify(b.stepIds);
  return false;
}

export class Store {
  private queues = new Map<string, Promise<void>>();
  private snapshots = new Map<string, Map<string, RecordFile>>();
  private errors = new Map<string, string>();
  private listeners = new Set<(event: ChangeEvent) => void>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  private scanning = false;
  private rescanPending = false;
  private constructor(readonly disk: Disk, private readonly runs?: RunStore) {}

  static async create(dataDir: string, pollIntervalMs = 1000, runs?: RunStore) {
    const store = new Store(await Disk.create(dataDir), runs);
    // Watch before the baseline scan so edits during startup cannot be missed.
    store.watcher = watch(store.disk.root, { recursive: true }, () => store.schedule());
    store.watcher.on('error', () => store.schedule());
    for (const id of await store.disk.projectIds()) {
      try { store.snapshots.set(id, await store.disk.scanProject(id)); }
      catch (error) { store.errors.set(id, String(error)); }
    }
    store.poll = setInterval(() => store.schedule(), pollIntervalMs);
    store.poll.unref();
    return store;
  }
  subscribe(listener: (event: ChangeEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() {
    this.closed = true;
    this.watcher?.close();
    clearTimeout(this.timer); clearInterval(this.poll);
    await Promise.all(this.queues.values());
  }
  private schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.rescan();
    }, 40);
  }
  private async rescan() {
    if (this.closed) return;
    if (this.scanning) { this.rescanPending = true; return; }
    this.scanning = true;
    try {
      const ids = new Set([...await this.disk.projectIds(), ...this.snapshots.keys(), ...this.errors.keys()]);
      await Promise.all([...ids].map((id) => this.lock(id, () => this.reconcile(id))));
    } catch { /* A later filesystem event or the fallback poll retries the scan. */ }
    finally {
      this.scanning = false;
      if (this.rescanPending) { this.rescanPending = false; this.schedule(); }
    }
  }
  private emit(event: ChangeEvent) { for (const listener of this.listeners) listener(event); }
  private async reconcile(id: string) {
    try {
      const next = await this.disk.scanProject(id);
      const previous = this.snapshots.get(id) ?? new Map<string, RecordFile>();
      this.errors.delete(id);
      this.snapshots.set(id, next);
      for (const [path, record] of next) {
        const before = previous.get(path);
        if (before?.revision === record.revision && before.error === record.error) continue;
        this.emit({
          type: record.error ? 'project-error' : !before ? 'created' : changedOrder(before, record) ? 'reordered' : 'updated',
          projectId: id, kind: record.kind, id: record.id, sceneId: record.sceneId,
          revision: record.revision, previousRevision: before?.revision, message: record.error,
        });
      }
      for (const [path, record] of previous) {
        if (!next.has(path)) this.emit({
          type: 'deleted', projectId: id, kind: record.kind, id: record.id, sceneId: record.sceneId,
          revision: null, previousRevision: record.revision,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cannot read project.';
      if (this.errors.get(id) !== message) this.emit({ type: 'project-error', kind: 'project', projectId: id, id, revision: null, message });
      this.errors.set(id, message);
    }
  }
  private lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    idSchema.parse(id);
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => {}, () => {});
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }
  async loadTree(id: string) {
    return this.load(id);
  }
  async withProjectLock<T>(id: string, operation: (state: { tree: ProjectTree; records: Map<string, RecordFile> }) => Promise<T>): Promise<T> {
    return this.lock(id, async () => {
      await this.reconcile(id);
      const state = await this.load(id);
      return operation(state);
    });
  }
  async applyTree(id: string, tree: ProjectTree, records: Map<string, RecordFile>, rawOverrides?: Map<string, Uint8Array>) {
    this.touch(tree);
    const parsed = validateProjectTree(tree);
    this.checkAssets(parsed, records);
    const next = documents(parsed);
    for (const file of next.keys()) {
      if (!records.has(file) && await this.disk.exists(file)) throw new ApiError(409, 'PATH_COLLISION', 'Document path already exists with another spelling.');
    }
    for (const [file, document] of next) {
      const existing = records.get(file);
      const override = rawOverrides?.get(file);
      if (override) {
        if (!existing || hash(override) !== existing.revision) {
          await this.disk.write(file, override);
        }
        continue;
      }
      const bytes = jsonBytes(document);
      const existingNormalized = existing?.document ? jsonBytes(existing.document) : undefined;
      if (!existing || (hash(bytes) !== existing.revision && (!existingNormalized || !bytes.equals(existingNormalized)))) {
        await this.disk.write(file, bytes);
      }
    }
    const nextSceneIds = new Set(parsed.scenes.map(({ scene }) => scene.id));
    for (const record of records.values()) {
      if (record.kind !== 'asset' && !next.has(record.path)) await this.disk.remove(record.path);
    }
    for (const record of records.values()) {
      if (record.kind === 'scene' && !nextSceneIds.has(record.id)) {
        await this.disk.remove(`${id}/scenes/${record.id}`);
      }
    }
    await this.reconcile(id);
    return parsed;
  }
  private async load(id: string) {
    let records: Map<string, RecordFile>;
    try { records = await this.disk.scanProject(id); }
    catch (error) { throw new ApiError(422, 'INVALID_PROJECT', error instanceof Error ? error.message : 'Cannot read project files.'); }
    const project = records.get(projectPath(id));
    if (!project) throw new ApiError(records.size ? 422 : 404, records.size ? 'INVALID_PROJECT' : 'NOT_FOUND', 'Project document not found.');
    try {
      for (const record of records.values()) if (record.error) throw new Error(record.error);
      const tree = validateProjectTree({
        project: project.document,
        scenes: [...records.values()].filter((r) => r.kind === 'scene').map((scene) => ({
          scene: scene.document,
          steps: [...records.values()].filter((r) => r.kind === 'step' && r.sceneId === scene.id).map((r) => r.document),
        })),
      });
      // Step files in a directory without scene.json must not disappear from validation.
      for (const record of records.values()) {
        if (record.kind === 'step' && !tree.scenes.some(({ scene }) => scene.id === record.sceneId)) throw new Error('Step has no scene document.');
      }
      this.checkAssets(tree, records);
      return { tree, records };
    } catch (error) {
      throw new ApiError(422, 'INVALID_PROJECT', error instanceof Error ? error.message : 'Invalid project.');
    }
  }
  private checkAssets(tree: ProjectTree, records: Map<string, RecordFile>) {
    for (const { steps } of tree.scenes) for (const step of steps) for (const file of Object.values(step.files)) {
      const asset = records.get(`${tree.project.id}/${file.path}`);
      if (!asset || asset.error) throw new ApiError(422, 'MISSING_ASSET', `Missing or unreadable asset ${file.path}.`);
    }
  }
  private require(records: Map<string, RecordFile>, path: string) {
    const record = records.get(path);
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
    return record;
  }
  private match(record: RecordFile, revision?: string) {
    if (!revision) throw new ApiError(428, 'REVISION_REQUIRED', 'Send the current ETag in If-Match.');
    if (revision !== `"${record.revision}"`) throw new ApiError(409, 'REVISION_CONFLICT', 'Document changed. Read it again before writing.');
  }
  async list() {
    return { projects: await Promise.all((await this.disk.projectIds()).map((id) => this.lock(id, async () => {
      try {
        const { records } = await this.load(id);
        return { id, ...envelope(records.get(projectPath(id))!) };
      } catch (error) { return { id, error: { code: 'INVALID_PROJECT', message: error instanceof Error ? error.message : 'Invalid project.' } }; }
    }))) };
  }
  async read(id: string, sceneId?: string, stepId?: string, list?: 'scenes' | 'steps') {
    return this.lock(id, async () => {
      const { tree, records } = await this.load(id);
      if (list === 'scenes') return { scenes: tree.project.sceneIds.map((s) => envelope(this.require(records, scenePath(id, s)))) };
      const path = stepId ? stepPath(id, sceneId!, stepId) : sceneId ? scenePath(id, sceneId) : projectPath(id);
      const record = this.require(records, path);
      if (list === 'steps') {
        const scene = tree.scenes.find(({ scene }) => scene.id === sceneId)!.scene;
        return { steps: scene.stepIds.map((t) => envelope(this.require(records, stepPath(id, sceneId!, t)))) };
      }
      return envelope(record);
    });
  }
  async create(input: unknown) {
    const data = projectCreateInput.parse(input);
    const project = createProject(data.name, { id: data.id, icon: data.icon });
    return this.lock(project.id, async () => {
      if (await this.disk.exists(project.id)) throw new ApiError(409, 'ALREADY_EXISTS', 'Project ID already exists.');
      await this.disk.write(projectPath(project.id), jsonBytes(project));
      await this.reconcile(project.id);
      return { document: project, revision: hash(jsonBytes(project)) };
    });
  }
  async mutate(id: string, action: 'rename' | 'delete' | 'createScene' | 'createStep' | 'updateStep' | 'duplicate' | 'orderScenes' | 'orderSteps',
    input: unknown, revision?: string, sceneId?: string, stepId?: string, actor: 'mcp' | 'user' = 'user') {
    return this.lock(id, async () => {
      await this.reconcile(id);
      const { tree, records } = await this.load(id);
      const path = stepId ? stepPath(id, sceneId!, stepId) : sceneId ? scenePath(id, sceneId) : projectPath(id);
      const target = this.require(records, path);
      const previousRevision = target.revision;
      const previousStep = stepId && target.document ? structuredClone(target.document as Step) : undefined;
      if (action !== 'createScene' && action !== 'createStep') this.match(target, revision);
      const entry = tree.scenes.find(({ scene }) => scene.id === sceneId);
      let resultPath = path;
      let createdId: string | undefined;
      if (action === 'rename') {
        if (sceneId) entry!.scene = parseScene({ ...entry!.scene, name: renameInput.parse(input).name });
        else {
          const { name = tree.project.name, icon = tree.project.icon } = projectPatchInput.parse(input);
          const next = { ...tree.project, name };
          if (icon) next.icon = icon; else delete next.icon;
          tree.project = parseProject(next);
        }
      } else if (action === 'createScene') {
        const data = namedInput.parse(input);
        const scene = createScene(data.name, { id: data.id });
        createdId = scene.id;
        tree.project.sceneIds.push(scene.id); tree.scenes.push({ scene, steps: [] });
        resultPath = scenePath(id, scene.id);
      } else if (action === 'createStep' || action === 'duplicate') {
        let step: Step;
        if (action === 'duplicate') {
          const data = duplicateInput.parse(input);
          if (data.id === stepId) throw new ApiError(409, 'ALREADY_EXISTS', 'A duplicated step needs a new ID.');
          step = duplicateStep(target.document as Step, data.id);
        } else {
          const data = stepInput.parse(input);
          step = createStep(data);
        }
        createdId = step.id;
        entry!.scene.stepIds.push(step.id); entry!.steps.push(step);
        resultPath = stepPath(id, sceneId!, step.id);
      } else if (action === 'updateStep') {
        const step = parseStep(input);
        if (step.id !== stepId) throw new ApiError(400, 'ID_MISMATCH', 'Step ID cannot change.');
        entry!.steps[entry!.steps.findIndex((s) => s.id === stepId)] = step;
      } else if (action === 'orderScenes') tree.project.sceneIds = orderInput.parse(input).ids;
      else if (action === 'orderSteps') entry!.scene.stepIds = orderInput.parse(input).ids;
      else if (action === 'delete') {
        if (stepId) {
          entry!.steps = entry!.steps.filter((s) => s.id !== stepId);
          entry!.scene.stepIds = entry!.scene.stepIds.filter((s) => s !== stepId);
        } else if (sceneId) {
          tree.scenes = tree.scenes.filter(({ scene }) => scene.id !== sceneId);
          tree.project.sceneIds = tree.project.sceneIds.filter((s) => s !== sceneId);
        } else {
          await this.disk.remove(id);
          await this.runs?.deleteProjectRuns(id);
          await this.reconcile(id);
          return null;
        }
      }
      this.touch(tree);
      const parsed = validateProjectTree(tree);
      this.checkAssets(parsed, records);
      const next = documents(parsed);
      // On case-insensitive volumes, a different valid ID can alias an existing path.
      // Check every destination before any write, including parent updates.
      for (const file of next.keys()) {
        if (!records.has(file) && await this.disk.exists(file)) throw new ApiError(409, 'PATH_COLLISION', 'Document path already exists with another spelling.');
      }
      for (const [file, document] of next) {
        const existing = records.get(file);
        const bytes = jsonBytes(document);
        const existingNormalized = existing?.document ? jsonBytes(existing.document) : undefined;
        if (!existing || file === resultPath || (hash(bytes) !== existing.revision && (!existingNormalized || !bytes.equals(existingNormalized)))) {
          if (hash(bytes) !== existing?.revision) await this.disk.write(file, bytes);
        }
      }
      for (const record of records.values()) {
        if (record.kind !== 'asset' && !next.has(record.path)) await this.disk.remove(record.path);
      }
      if (action === 'delete' && sceneId && !stepId) await this.disk.remove(`${id}/scenes/${sceneId}`);
      await this.reconcile(id);
      if (action === 'delete') return null;
      const document = next.get(resultPath)!;
      const newRevision = hash(jsonBytes(document));
      await this.runs?.recordMutation(id, {
        action,
        actor,
        sceneId,
        stepId,
        createdId,
        previousRevision,
        newRevision,
        previousStep,
        newStep: action === 'updateStep' ? (document as Step) : undefined,
      });
      return { document, revision: newRevision };
    });
  }
  private touch(tree: ProjectTree) {
    tree.project.updatedAt = new Date(Math.max(Date.now(), Date.parse(tree.project.updatedAt) + 1)).toISOString();
  }
  async asset(id: string, filename: string, method: 'GET' | 'PUT' | 'DELETE', bytes?: Buffer, revision?: string) {
    const fileId = assetName(filename);
    return this.lock(id, async () => {
      await this.reconcile(id);
      const { tree, records } = await this.load(id);
      const path = `${id}/assets/${filename}`;
      const record = records.get(path);
      if (method === 'GET') {
        if (!record) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.');
        const content = await this.disk.read(path);
        return { bytes: content, revision: hash(content) };
      }
      if (method === 'PUT') {
        const existing = [...records.values()].find((r) => r.kind === 'asset' && assetName(r.id) === fileId);
        if (existing && (existing.path !== path || existing.revision !== hash(bytes!))) throw new ApiError(409, 'IMMUTABLE_ASSET', 'Different bytes require a new file ID.');
        if (existing) return { revision: existing.revision };
        if (await this.disk.exists(path)) throw new ApiError(409, 'PATH_COLLISION', 'Asset path already exists with another spelling.');
        await this.disk.write(path, bytes!);
      } else {
        if (!record) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.');
        this.match(record, revision);
        if (tree.scenes.some(({ steps }) => steps.some((step) => Object.values(step.files).some((file) => file.path === `assets/${filename}`)))) {
          throw new ApiError(409, 'ASSET_IN_USE', 'Remove all manifest references before deleting this asset.');
        }
        await this.disk.remove(path);
      }
      this.touch(tree);
      await this.disk.write(projectPath(id), jsonBytes(tree.project));
      await this.reconcile(id);
      return method === 'PUT' ? { revision: hash(bytes!) } : null;
    });
  }
}
