import { z } from 'zod';
import {
  SCHEMA_VERSION, projectSchema, sceneSchema, stepSchema,
  type Project, type Scene, type Step, type FileManifestEntry,
} from './format.js';

export function createProject(name: string, options: { id?: string; now?: string; icon?: string } = {}): Project {
  const now = options.now ?? new Date().toISOString();
  return projectSchema.parse({
    schemaVersion: SCHEMA_VERSION, id: options.id ?? crypto.randomUUID(),
    name, ...(options.icon === undefined ? {} : { icon: options.icon }), createdAt: now, updatedAt: now, sceneIds: [],
  });
}

export function createScene(name: string, options: { id?: string } = {}): Scene {
  return sceneSchema.parse({
    schemaVersion: SCHEMA_VERSION, id: options.id ?? crypto.randomUUID(), name, stepIds: [],
  });
}

export function createStep(options: Partial<Omit<Step, 'schemaVersion'>> = {}): Step {
  return structuredClone(stepSchema.parse({
    ...options,
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? crypto.randomUUID(),
    elements: options.elements ?? [],
    appState: options.appState ?? { viewBackgroundColor: '#ffffff' },
    files: options.files ?? {},
  }));
}

export function duplicateStep(source: Step, id: string = crypto.randomUUID()): Step {
  if (id === source.id) throw new Error('A duplicated step must have a new ID.');
  return createStep({ ...source, id });
}

/** Arrays retain duplicate children so validation can detect them. */
export const projectTreeSchema = z.object({
  project: projectSchema,
  scenes: z.array(z.object({ scene: sceneSchema, steps: z.array(stepSchema) }).strict()),
}).strict().superRefine((tree, context) => {
  type Path = (string | number)[];
  const issue = (path: Path, message: string) => context.addIssue({ code: 'custom', path, message });
  const ids = new Set<string>();
  const register = (id: string, path: Path) => {
    if (ids.has(id)) issue(path, `Duplicate document ID "${id}".`);
    ids.add(id);
  };
  const checkOrder = (order: string[], children: string[], path: Path) => {
    const orderedIds = new Set<string>();
    const childIds = new Set(children);
    order.forEach((id, index) => {
      if (orderedIds.has(id)) issue([...path, index], `Duplicate ordered ID "${id}".`);
      orderedIds.add(id);
      if (!childIds.has(id)) issue([...path, index], `Ordered ID "${id}" has no child.`);
    });
    for (const id of childIds) {
      if (!orderedIds.has(id)) issue(path, `Child "${id}" is missing from the order list.`);
    }
  };

  register(tree.project.id, ['project', 'id']);
  checkOrder(tree.project.sceneIds, tree.scenes.map(({ scene }) => scene.id), ['project', 'sceneIds']);
  const assets = new Map<string, FileManifestEntry>();
  tree.scenes.forEach(({ scene, steps }, sceneIndex) => {
    const base: Path = ['scenes', sceneIndex];
    register(scene.id, [...base, 'scene', 'id']);
    checkOrder(scene.stepIds, steps.map((step) => step.id), [...base, 'scene', 'stepIds']);
    steps.forEach((step, stepIndex) => {
      const stepPath = [...base, 'steps', stepIndex];
      register(step.id, [...stepPath, 'id']);
      const elementIds = new Set<string>();
      step.elements.forEach((element, elementIndex) => {
        const elementPath = [...stepPath, 'elements', elementIndex];
        if (elementIds.has(element.id)) issue([...elementPath, 'id'], `Duplicate element ID "${element.id}" within a step.`);
        elementIds.add(element.id);
        if (element.fileId != null && !Object.hasOwn(step.files, element.fileId)) {
          issue([...elementPath, 'fileId'], `Referenced fileId "${element.fileId}" has no manifest entry.`);
        }
      });
      for (const [fileId, file] of Object.entries(step.files)) {
        const existing = assets.get(fileId);
        if (existing && (existing.path !== file.path || existing.mimeType !== file.mimeType ||
          existing.created !== file.created || existing.version !== file.version)) {
          issue([...stepPath, 'files', fileId], `Conflicting manifest entries for project asset "${fileId}".`);
        }
        assets.set(fileId, file);
      }
    });
  });
});

export type ProjectTree = z.infer<typeof projectTreeSchema>;

/** Return a parsed tree or throw a ZodError with paths for every inconsistency. */
export function validateProjectTree(input: unknown): ProjectTree {
  return projectTreeSchema.parse(input);
}
