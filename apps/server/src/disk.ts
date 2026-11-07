import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { idSchema, parseProject, parseScene, parseStep, type Project, type Scene, type Step } from '@paso/shared';
import { ApiError, isMissing } from './errors.js';

export type Document = Project | Scene | Step;
export type RecordFile = {
  path: string; kind: 'project' | 'scene' | 'step' | 'asset'; projectId: string;
  sceneId?: string; id: string; revision: string; document?: Document; error?: string;
};
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (document: Document) => Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
export function assetName(name: string) {
  const match = /^([A-Za-z0-9_-]{1,128})\.([a-z0-9]+)$/.exec(name);
  if (!match) throw new ApiError(400, 'INVALID_PATH', 'Invalid asset filename.');
  idSchema.parse(match[1]);
  return match[1];
}

/** All filesystem access is confined to this real root. No links below it. */
export class Disk {
  private constructor(readonly root: string) {}
  static async create(root: string) {
    await mkdir(root, { recursive: true });
    return new Disk(await realpath(root));
  }
  async path(path: string) {
    const full = join(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) {
      throw new ApiError(400, 'INVALID_PATH', 'Path leaves data directory.');
    }
    let current = this.root;
    for (const component of rel.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new ApiError(422, 'UNSAFE_PATH', 'Symbolic links are not supported.');
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    return full;
  }
  async exists(path: string) {
    try { await lstat(await this.path(path)); return true; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }
  async read(path: string) {
    const file = await open(await this.path(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new ApiError(422, 'UNSAFE_PATH', 'Expected a regular file.');
      return await file.readFile();
    } finally { await file.close(); }
  }
  async entries(path: string) {
    try { return await readdir(await this.path(path), { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }
  async write(path: string, bytes: Uint8Array) {
    const target = await this.path(path);
    await mkdir(dirname(target), { recursive: true });
    await this.path(path);
    const temporary = join(dirname(target), `.paso-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await this.path(path);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(path: string) { await rm(await this.path(path), { recursive: true, force: true }); }

  async scanProject(projectId: string): Promise<Map<string, RecordFile>> {
    idSchema.parse(projectId);
    const records = new Map<string, RecordFile>();
    const add = async (path: string, kind: RecordFile['kind'], id: string, sceneId?: string) => {
      try {
        const bytes = await this.read(path);
        const record: RecordFile = { path, kind, projectId, sceneId, id, revision: hash(bytes) };
        if (kind !== 'asset') {
          try {
            const parse = kind === 'project' ? parseProject : kind === 'scene' ? parseScene : parseStep;
            record.document = parse(JSON.parse(bytes.toString('utf8')));
            if (record.document.id !== id) throw new Error('Document ID does not match its filename.');
          } catch (error) { record.error = error instanceof Error ? error.message : 'Invalid document.'; }
        }
        records.set(path, record);
      } catch (error) {
        if (isMissing(error)) return;
        records.set(path, { path, kind, projectId, sceneId, id, revision: 'unreadable', error: error instanceof Error ? error.message : 'Unreadable file.' });
      }
    };
    await add(`${projectId}/project.json`, 'project', projectId);
    for (const entry of await this.entries(`${projectId}/scenes`)) {
      if (!idSchema.safeParse(entry.name).success || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const sceneId = entry.name;
      const root = `${projectId}/scenes/${sceneId}`;
      await add(`${root}/scene.json`, 'scene', sceneId, sceneId);
      for (const step of await this.entries(`${root}/steps`)) {
        if (!step.name.endsWith('.json') || !idSchema.safeParse(step.name.slice(0, -5)).success) continue;
        await add(`${root}/steps/${step.name}`, 'step', step.name.slice(0, -5), sceneId);
      }
    }
    for (const asset of await this.entries(`${projectId}/assets`)) {
      if (!/^([A-Za-z0-9_-]{1,128})\.[a-z0-9]+$/.test(asset.name)) continue;
      await add(`${projectId}/assets/${asset.name}`, 'asset', asset.name);
    }
    return records;
  }
  async projectIds() {
    return (await this.entries('')).filter((entry) =>
      (entry.isDirectory() || entry.isSymbolicLink()) && idSchema.safeParse(entry.name).success,
    ).map((entry) => entry.name).sort();
  }
}
