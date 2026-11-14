import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { idSchema } from '@paso/shared';
import { z } from 'zod';
import { ApiError, isMissing } from './errors.js';

/** A folder of projects. `default` is the service's own data directory, which is always listed. */
export type Workspace = { id: string; name: string; path: string };
export type WorkspaceInfo = Workspace & { default: boolean; available: boolean };

export const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'Mis diagramas';

const workspaceSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(200), path: z.string().min(1) }).strict();
const fileSchema = z.object({
  schemaVersion: z.literal(1),
  /** The data directory this list was written with. The active workspace is only restored for the same one. */
  defaultPath: z.string(),
  activeId: z.string(),
  workspaces: z.array(workspaceSchema),
}).strict();
const addInput = z.object({ path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(200).optional() }).strict();
const folderNameInput = z.object({ parent: z.string().min(1).max(4096), name: z.string().trim().min(1).max(255) }).strict();

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

async function isFolder(path: string) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Where the workspace list is kept: next to the default data directory, never inside it. */
export function workspacesPath(dataDir: string, configured?: string) {
  const root = resolve(dataDir);
  const file = resolve(configured ?? join(dirname(root), 'workspaces.json'));
  if (inside(file, root)) throw new Error('The workspace list must be outside dataDir.');
  return file;
}

/**
 * The list of workspaces and which one is open. It lives in the app's own configuration, so adding or removing a
 * workspace never writes into the folders themselves, and removing one never deletes anything.
 */
export class WorkspaceRegistry {
  private extra: Workspace[] = [];
  private activeId = DEFAULT_WORKSPACE_ID;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly defaultPath: string,
    /** Folders a workspace may not be, contain or sit inside: the app's own data, runs and agent folders. */
    private readonly reserved: string[],
  ) {}

  static async create(file: string, defaultPath: string, reserved: string[]) {
    const registry = new WorkspaceRegistry(file, resolve(defaultPath), reserved.map((path) => resolve(path)));
    try {
      const saved = fileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      registry.extra = saved.workspaces.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID && isAbsolute(workspace.path));
      // A list written with another data directory belongs to another setup, such as a test or PASO_DATA_DIR:
      // its workspaces stay listed, but the service starts in its own folder.
      if (saved.defaultPath === registry.defaultPath && registry.find(saved.activeId)) registry.activeId = saved.activeId;
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
    }
    return registry;
  }

  private find(id: string): Workspace | undefined {
    if (id === DEFAULT_WORKSPACE_ID) return { id, name: DEFAULT_WORKSPACE_NAME, path: this.defaultPath };
    return this.extra.find((workspace) => workspace.id === id);
  }
  get(id: string) {
    const workspace = this.find(id);
    if (!workspace) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    return workspace;
  }
  active() { return this.get(this.activeId); }
  isDefault(id: string) { return id === DEFAULT_WORKSPACE_ID; }

  async list() {
    const all = [this.get(DEFAULT_WORKSPACE_ID), ...this.extra];
    const workspaces: WorkspaceInfo[] = await Promise.all(all.map(async (workspace) => ({
      ...workspace, default: this.isDefault(workspace.id), available: this.isDefault(workspace.id) || await isFolder(workspace.path),
    })));
    return { activeId: this.activeId, workspaces };
  }

  private save() {
    const data = { schemaVersion: 1, defaultPath: this.defaultPath, activeId: this.activeId, workspaces: this.extra };
    const next = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temporary, this.file);
    });
    this.writes = next.catch(() => {});
    return next;
  }

  /** Adds an existing folder. It must not be, contain or sit inside another workspace or the app's own folders. */
  async add(input: unknown) {
    const { path, name } = addInput.parse(input);
    if (!isAbsolute(path)) throw new ApiError(400, 'INVALID_PATH', 'Use an absolute path.');
    let real: string;
    try { real = await realpath(path); } catch { throw new ApiError(422, 'FOLDER_NOT_FOUND', 'La carpeta no existe.'); }
    if (!await isFolder(real)) throw new ApiError(422, 'FOLDER_NOT_FOUND', 'No es una carpeta.');
    if (real === parse(real).root || real === resolve(homedir())) {
      throw new ApiError(422, 'FOLDER_TOO_BROAD', 'Elige una carpeta concreta, no la carpeta personal ni la raíz del disco.');
    }
    const existing = [this.get(DEFAULT_WORKSPACE_ID), ...this.extra];
    const realOf = async (target: string) => { try { return await realpath(target); } catch { return resolve(target); } };
    for (const workspace of existing) {
      const other = await realOf(workspace.path);
      if (other === real) throw new ApiError(409, 'WORKSPACE_EXISTS', `Esta carpeta ya es el workspace «${workspace.name}».`);
      if (overlaps(real, other)) throw new ApiError(422, 'WORKSPACE_OVERLAP', `Esta carpeta está dentro de «${workspace.name}» o lo contiene.`);
    }
    for (const folder of this.reserved) {
      if (overlaps(real, await realOf(folder))) throw new ApiError(422, 'RESERVED_FOLDER', 'Esta carpeta la usa Paso para sus propios datos.');
    }
    const workspace: Workspace = { id: randomUUID(), name: name ?? basename(real), path: real };
    this.extra.push(workspace);
    await this.save();
    return { ...workspace, default: false, available: true } satisfies WorkspaceInfo;
  }

  /** Removes a workspace from the list. Its folder and files stay where they are. */
  async remove(id: string) {
    this.get(id);
    if (this.isDefault(id)) throw new ApiError(400, 'DEFAULT_WORKSPACE', 'The default workspace cannot be removed.');
    this.extra = this.extra.filter((workspace) => workspace.id !== id);
    if (this.activeId === id) this.activeId = DEFAULT_WORKSPACE_ID;
    await this.save();
  }

  async activate(id: string) {
    this.get(id);
    this.activeId = id;
    await this.save();
  }
}

export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  folders: Array<{ name: string; path: string }>;
  /** Immediate subfolders with a project.json: the projects this folder would show as a workspace. */
  projects: number;
  /** The way down to this folder, from the home folder when it is inside it, otherwise from the disk's root. */
  crumbs: Array<{ name: string; path: string }>;
};

function crumbsTo(target: string, home: string) {
  const base = inside(target, home) ? home : parse(target).root;
  const crumbs = [{ name: base === home ? basename(home) : base, path: base }];
  const rest = relative(base, target);
  for (const part of rest ? rest.split(sep) : []) crumbs.push({ name: part, path: join(crumbs[crumbs.length - 1].path, part) });
  return crumbs;
}

const unreadable = () => new ApiError(422, 'FOLDER_UNREADABLE', 'No se puede leer esta carpeta.');

/**
 * The folder explorer behind «Nuevo workspace». It lists folder names only: never files, never their contents, and
 * no hidden folders. Links to folders are not followed.
 */
export async function listFolders(path?: string): Promise<FolderListing> {
  const home = resolve(homedir());
  const target = path ? resolve(path) : home;
  if (path && !isAbsolute(path)) throw new ApiError(400, 'INVALID_PATH', 'Use an absolute path.');
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new ApiError(404, 'FOLDER_NOT_FOUND', 'La carpeta no existe.');
    throw unreadable();
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true }));
  let projects = 0;
  // Bounded: a folder with thousands of subfolders is not a workspace anyone means to pick.
  await Promise.all(folders.slice(0, 500).map(async (folder) => {
    try { if ((await stat(join(folder.path, 'project.json'))).isFile()) projects += 1; } catch { /* not a project */ }
  }));
  const parent = dirname(target);
  return { path: target, parent: parent === target ? null : parent, home, folders, projects, crumbs: crumbsTo(target, home) };
}

/** Creates one folder inside another, for «Nueva carpeta» in the explorer. */
export async function createFolder(input: unknown) {
  const { parent, name } = folderNameInput.parse(input);
  if (!isAbsolute(parent)) throw new ApiError(400, 'INVALID_PATH', 'Use an absolute path.');
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new ApiError(400, 'INVALID_NAME', 'El nombre no puede contener barras.');
  if (!await isFolder(parent)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'La carpeta no existe.');
  const path = join(resolve(parent), name);
  try { await mkdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError(409, 'FOLDER_EXISTS', 'Ya hay una carpeta con ese nombre.');
    throw unreadable();
  }
  return { path };
}
