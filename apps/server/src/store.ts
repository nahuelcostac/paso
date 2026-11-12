import { watch, type FSWatcher } from 'node:fs';
import {
  createProject, createScene, createStep, duplicateStep, idSchema, parseProject, parseScene, parseStep,
  validateProjectTree, stepSchema, iconNameSchema, isLooseProject, LOOSE_PROJECT_ID, LOOSE_PROJECT_NAME,
  type Project, type ProjectTree, type Step,
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
const duplicateInput = z.object({ id: idSchema.optional(), title: z.string().max(500).optional() }).strict();
const moveInput = z.object({ projectId: idSchema }).strict();
/** What an unfinished move left behind, so a restart can finish it or undo it. */
const journalSchema = z.object({
  sceneId: idSchema, targetId: idSchema,
  /** Asset paths the scene uses, and those of them that were copied into the project because it lacked them. */
  assets: z.array(z.string()), addedAssets: z.array(z.string()),
}).strict();
type Journal = z.infer<typeof journalSchema>;
const projectPath = (id: string) => `${id}/project.json`;
// Neither folder is read as part of a project: scans only look at project.json, scenes/ and assets/.
const journalDir = (source: string) => `${source}/.moves`;
const journalPath = (source: string, sceneId: string) => `${journalDir(source)}/${sceneId}.json`;
const stagingDir = (target: string) => `${target}/.incoming`;
const stagingPath = (target: string, sceneId: string) => `${stagingDir(target)}/${sceneId}`;
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
    // A move cut short by a crash is finished or undone before anything reads the projects.
    await store.recoverMoves();
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
      await this.runs?.observeState(this, state.tree, state.records);
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
    // The loose diagrams' reserved project is never listed: it is read by its ID only.
    const ids = (await this.disk.projectIds()).filter((id) => !isLooseProject(id));
    return { projects: await Promise.all(ids.map((id) => this.lock(id, async () => {
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
    if (isLooseProject(project.id)) throw new ApiError(409, 'RESERVED_PROJECT', 'This project ID is reserved for loose diagrams.');
    return this.lock(project.id, async () => {
      if (await this.disk.exists(project.id)) throw new ApiError(409, 'ALREADY_EXISTS', 'Project ID already exists.');
      await this.disk.write(projectPath(project.id), jsonBytes(project));
      await this.reconcile(project.id);
      return { document: project, revision: hash(jsonBytes(project)) };
    });
  }
  async mutate(id: string, action: 'rename' | 'delete' | 'createScene' | 'createStep' | 'updateStep' | 'duplicate' | 'orderScenes' | 'orderSteps',
    input: unknown, revision?: string, sceneId?: string, stepId?: string, actor: 'mcp' | 'user' = 'user') {
    if (isLooseProject(id) && !sceneId && (action === 'rename' || action === 'delete')) {
      throw new ApiError(400, 'RESERVED_PROJECT', 'The loose diagrams cannot be renamed or deleted as a project. Rename or delete each scene.');
    }
    return this.lock(id, async () => {
      // The loose diagrams' project appears with its first diagram.
      if (isLooseProject(id) && action === 'createScene' && !(await this.disk.exists(projectPath(id)))) {
        await this.disk.write(projectPath(id), jsonBytes(createProject(LOOSE_PROJECT_NAME, { id: LOOSE_PROJECT_ID })));
      }
      await this.reconcile(id);
      const { tree, records } = await this.load(id);
      const path = stepId ? stepPath(id, sceneId!, stepId) : sceneId ? scenePath(id, sceneId) : projectPath(id);
      const target = this.require(records, path);
      if (action !== 'createScene' && action !== 'createStep') this.match(target, revision);
      await this.runs?.observeState(this, tree, records);
      const entry = tree.scenes.find(({ scene }) => scene.id === sceneId);
      let resultPath = path;
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
        tree.project.sceneIds.push(scene.id); tree.scenes.push({ scene, steps: [] });
        resultPath = scenePath(id, scene.id);
      } else if (action === 'createStep' || action === 'duplicate') {
        let step: Step;
        if (action === 'duplicate') {
          const data = duplicateInput.parse(input);
          if (data.id === stepId) throw new ApiError(409, 'ALREADY_EXISTS', 'A duplicated step needs a new ID.');
          step = duplicateStep(target.document as Step, data.id);
          if (data.title !== undefined) step.title = data.title;
        } else {
          const data = stepInput.parse(input);
          step = createStep(data);
        }
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
      if (this.runs?.hasActiveRun(id)) {
        const refreshed = await this.load(id);
        await this.runs.recordMutation(actor, action, records, refreshed.tree, refreshed.records, sceneId);
      }
      if (action === 'delete') return null;
      const document = next.get(resultPath)!;
      const newRevision = hash(jsonBytes(document));
      return { document, revision: newRevision };
    });
  }
  /**
   * Moves a scene to the end of another project, with its steps, element IDs and images: a loose diagram into a project,
   * a scene out of one into the loose diagrams, or from one project to another. Files are copied, byte for byte, into a
   * staging folder and checked; then the folder is renamed into place and the target's scene list is written. That write
   * is the commit: before it the source is untouched, after it the target holds the scene and only the source copy is
   * left to remove. A journal in the source lets a restart finish or undo a move cut short.
   */
  async moveScene(sourceId: string, sceneId: string, input: unknown, revision?: string) {
    const { projectId: targetId } = moveInput.parse(input);
    if (sourceId === targetId) throw new ApiError(400, 'MOVE_NOT_SUPPORTED', 'The scene is already in this project.');
    // Both projects are locked, always in the same order, so two moves cannot wait on each other.
    const [first, second] = [sourceId, targetId].sort();
    return this.lock(first, () => this.lock(second, async () => {
      // A scene taken out of a project becomes the first loose diagram if there is none yet.
      if (isLooseProject(targetId) && await this.disk.exists(projectPath(sourceId)) && !(await this.disk.exists(projectPath(targetId)))) {
        await this.disk.write(projectPath(targetId), jsonBytes(createProject(LOOSE_PROJECT_NAME, { id: LOOSE_PROJECT_ID })));
      }
      const pending = await this.readJournal(sourceId, sceneId);
      if (pending && pending.targetId !== targetId) throw new ApiError(409, 'MOVE_PENDING', 'An earlier move of this diagram is unfinished. Restart Paso to complete it.');
      if (pending) await this.recoverMove(sourceId, pending);
      await this.reconcile(sourceId);
      await this.reconcile(targetId);
      const source = await this.load(sourceId);
      const target = await this.load(targetId);
      const sceneRecord = this.require(source.records, scenePath(sourceId, sceneId));
      this.match(sceneRecord, revision);
      if (this.runs?.hasActiveRun(sourceId) || this.runs?.hasActiveRun(targetId)) {
        throw new ApiError(409, 'AGENT_RUNNING', 'Wait for the agent to finish before moving the scene.');
      }
      const entry = source.tree.scenes.find(({ scene }) => scene.id === sceneId)!;

      // Document IDs are unique across a project. They are kept, so a clash stops the move.
      const taken = new Set([targetId, ...target.tree.scenes.flatMap(({ scene, steps }) => [scene.id, ...steps.map((step) => step.id)])]);
      if ([entry.scene.id, ...entry.steps.map((step) => step.id)].some((id) => taken.has(id))) {
        throw new ApiError(409, 'ID_COLLISION', 'The project already has a scene or step with one of these IDs.');
      }
      // Images are copied unless the project already has the same bytes under the same file ID.
      const manifest = new Map(target.tree.scenes.flatMap(({ steps }) => steps.flatMap((step) => Object.entries(step.files))));
      const assets = new Map<string, Buffer>();
      const added: string[] = [];
      for (const step of entry.steps) for (const [fileId, file] of Object.entries(step.files)) {
        const known = manifest.get(fileId);
        if (known && (known.path !== file.path || known.mimeType !== file.mimeType || known.created !== file.created || known.version !== file.version)) {
          throw new ApiError(409, 'ASSET_CONFLICT', 'The project has a different image with the same file ID.');
        }
        if (assets.has(file.path)) continue;
        const bytes = await this.disk.read(`${sourceId}/${file.path}`);
        const existing = [...target.records.values()].find((record) => record.kind === 'asset' && assetName(record.id) === fileId);
        if (existing && (existing.path !== `${targetId}/${file.path}` || existing.revision !== hash(bytes))) {
          throw new ApiError(409, 'ASSET_CONFLICT', 'The project has a different image with the same file ID.');
        }
        if (!existing) {
          if (await this.disk.exists(`${targetId}/${file.path}`)) throw new ApiError(409, 'PATH_COLLISION', 'Asset path already exists with another spelling.');
          added.push(file.path);
        }
        assets.set(file.path, bytes);
      }
      // The files are copied as they are on disk, so their revisions stay the same in the project.
      const files = new Map<string, Buffer>();
      const raw = async (record: RecordFile, name: string) => {
        const bytes = await this.disk.read(record.path);
        if (hash(bytes) !== record.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The diagram changed while it was being moved. Try again.');
        files.set(name, bytes);
      };
      await raw(sceneRecord, 'scene.json');
      for (const step of entry.steps) await raw(this.require(source.records, stepPath(sourceId, sceneId, step.id)), `steps/${step.id}.json`);

      const nextTarget = structuredClone(target.tree);
      nextTarget.project.sceneIds.push(sceneId);
      nextTarget.scenes.push(structuredClone(entry));
      this.touch(nextTarget);
      validateProjectTree(nextTarget);
      if (await this.disk.exists(`${targetId}/scenes/${sceneId}`)) throw new ApiError(409, 'PATH_COLLISION', 'Scene path already exists with another spelling.');

      const journal: Journal = { sceneId, targetId, assets: [...assets.keys()], addedAssets: added };
      await this.disk.write(journalPath(sourceId, sceneId), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`));
      const staging = stagingPath(targetId, sceneId);
      try {
        for (const path of added) await this.disk.write(`${targetId}/${path}`, assets.get(path)!);
        for (const [name, bytes] of files) await this.disk.write(`${staging}/${name}`, bytes);
        // Read every copy back before the project refers to it.
        for (const path of added) if (hash(await this.disk.read(`${targetId}/${path}`)) !== hash(assets.get(path)!)) throw new Error('An image copy does not match.');
        for (const [name, bytes] of files) if (hash(await this.disk.read(`${staging}/${name}`)) !== hash(bytes)) throw new Error('A copied file does not match.');
        await this.disk.rename(staging, `${targetId}/scenes/${sceneId}`);
        await this.disk.write(projectPath(targetId), jsonBytes(nextTarget.project));
      } catch (error) {
        // The commit may have landed even if the call failed: the project's own file says.
        if (!(await this.committed(targetId, sceneId))) {
          try { await this.recoverMove(sourceId, journal); } catch { /* The journal stays; the next start undoes the move. */ }
          await this.reconcile(targetId);
          await this.reconcile(sourceId);
          throw error;
        }
      }
      // Committed: the target holds the scene. Removing the source copy is finished now, or at the next start.
      try { await this.recoverMove(sourceId, journal); } catch { /* The journal stays for the next start. */ }
      await this.reconcile(targetId);
      await this.reconcile(sourceId);
      const moved = this.snapshots.get(targetId)?.get(scenePath(targetId, sceneId));
      return { projectId: targetId, document: moved?.document ?? entry.scene, revision: moved?.revision ?? sceneRecord.revision };
    }));
  }
  private async readJournal(sourceId: string, sceneId: string) {
    if (!(await this.disk.exists(journalPath(sourceId, sceneId)))) return undefined;
    return journalSchema.parse(JSON.parse((await this.disk.read(journalPath(sourceId, sceneId))).toString('utf8')));
  }
  private async committed(targetId: string, sceneId: string) {
    try { return parseProject(JSON.parse((await this.disk.read(projectPath(targetId))).toString('utf8'))).sceneIds.includes(sceneId); }
    catch { return false; }
  }
  /** Finishes a committed move, or undoes one that never committed. Each step can run again safely. */
  private async recoverMove(sourceId: string, journal: Journal) {
    const { sceneId, targetId } = journal;
    const readProject = async (id: string): Promise<Project | undefined> => {
      try { return parseProject(JSON.parse((await this.disk.read(projectPath(id))).toString('utf8'))); }
      catch { return undefined; }
    };
    const referenced = async (id: string) => {
      const records = await this.disk.scanProject(id);
      if ([...records.values()].some((record) => record.error)) return undefined;
      return new Set([...records.values()].flatMap((record) => record.kind === 'step' ? Object.values((record.document as Step).files).map((file) => file.path) : []));
    };
    const pruneAssets = async (id: string, paths: string[]) => {
      const used = await referenced(id);
      if (!used) return;
      for (const path of paths) if (!used.has(path)) await this.disk.remove(`${id}/${path}`);
    };
    // One move at a time per project, under its lock: the whole staging folder belongs to this one.
    await this.disk.remove(stagingDir(targetId));
    if (await this.committed(targetId, sceneId)) {
      const source = await readProject(sourceId);
      if (source?.sceneIds.includes(sceneId)) {
        source.sceneIds = source.sceneIds.filter((id) => id !== sceneId);
        source.updatedAt = new Date(Math.max(Date.now(), Date.parse(source.updatedAt) + 1)).toISOString();
        await this.disk.write(projectPath(sourceId), jsonBytes(source));
      }
      await this.disk.remove(`${sourceId}/scenes/${sceneId}`);
      // Images only the moved diagram used now live in the target. A project keeps its own, as deleting a scene does,
      // since an agent run's restore point may still refer to them; the hidden loose folder is tidied.
      if (isLooseProject(sourceId)) await pruneAssets(sourceId, journal.assets);
    } else {
      // Never committed: the source is still whole. Only a copy is removed, and only while the original is there.
      const source = await readProject(sourceId);
      if (!source?.sceneIds.includes(sceneId)) return;
      await this.disk.remove(`${targetId}/scenes/${sceneId}`);
      await pruneAssets(targetId, journal.addedAssets);
    }
    await this.disk.remove(journalPath(sourceId, sceneId));
    await this.disk.removeEmptyFolder(journalDir(sourceId));
  }
  /** At start-up: every move a crash cut short is finished or undone. Each journal sits in its move's source. */
  private async recoverMoves() {
    for (const sourceId of await this.disk.projectIds()) {
      for (const entry of await this.disk.entries(journalDir(sourceId))) {
        if (!entry.name.endsWith('.json') || !idSchema.safeParse(entry.name.slice(0, -5)).success) continue;
        try {
          const journal = await this.readJournal(sourceId, entry.name.slice(0, -5));
          if (journal) await this.recoverMove(sourceId, journal);
        } catch { /* Left for the next start; the projects themselves are read as they are. */ }
      }
    }
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
