import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createProject, createScene, createStep, duplicateStep, migrateDocument,
  parseProject, parseScene, parseStep, projectSchema, sceneSchema, stepSchema,
  validateProjectTree, type ProjectTree,
} from './index.js';

function fixture(): ProjectTree {
  const project = createProject('Example', { id: 'project-1', now: '2026-11-07T12:00:00.000Z' });
  const scene = createScene('First scene', { id: 'scene-1' });
  const step = createStep({
    id: 'step-1',
    elements: [{
      id: 'element-1', type: 'image', version: 1, versionNonce: 42, isDeleted: false,
      fileId: 'image-1', x: 10, customData: { nested: ['original'] },
    }],
    files: { 'image-1': { path: 'assets/image-1.svg', mimeType: 'image/svg+xml', created: 1 } },
  });
  const second = duplicateStep(step, 'step-2');
  project.sceneIds = [scene.id];
  scene.stepIds = [step.id, second.id];
  return { project, scenes: [{ scene, steps: [step, second] }] };
}

describe('versioned documents', () => {
  it('round-trips unknown element types and nested fields without loss', () => {
    const original = fixture().scenes[0].steps[0];
    original.elements[0].type = 'future-excalidraw-shape';
    original.elements[0].futureField = { geometry: [1, { pressure: 0.5 }], enabled: true };
    const parsed = parseStep(JSON.parse(JSON.stringify(original)));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(original);
  });

  it.each([
    ['project', () => fixture().project, parseProject, projectSchema],
    ['scene', () => fixture().scenes[0].scene, parseScene, sceneSchema],
    ['step', () => fixture().scenes[0].steps[0], parseStep, stepSchema],
  ] as const)('rejects newer versions in %s parsers and schemas', (_name, make, parse, schema) => {
    const value = { ...make(), schemaVersion: 2 };
    expect(() => parse(value)).toThrow('Schema version 2 is newer than supported version 1');
    expect(() => schema.parse(value)).toThrow('Schema version 2 is newer than supported version 1');
  });

  it('rejects newer nested documents when validating a tree', () => {
    const tree = fixture();
    Object.assign(tree.scenes[0].steps[1], { schemaVersion: 2 });
    expect(() => validateProjectTree(tree)).toThrow('newer than supported version 1');
  });

  it('has a no-op v1 migration and rejects unsupported envelopes', () => {
    const project = fixture().project;
    expect(migrateDocument(project)).toBe(project);
    for (const value of [null, {}, { schemaVersion: 0 }, { schemaVersion: '1' }]) {
      expect(() => migrateDocument(value)).toThrow();
    }
    expect(() => migrateDocument({ schemaVersion: 2 })).toThrow('newer than supported');
  });

  it('keeps only the four durable appState fields', () => {
    const step = fixture().scenes[0].steps[0];
    const appState = { viewBackgroundColor: '#eeeeee', gridSize: 20, gridStep: 5, gridModeEnabled: true };
    expect(parseStep({ ...step, appState: {
      ...appState, selectedElementIds: { 'element-1': true }, cursorButton: 'down',
      zoom: { value: 2 }, scrollX: 100, scrollY: -20, collaborators: {},
      activeTool: { type: 'rectangle' }, theme: 'dark', exportBackground: true,
      futureUiField: 'transient',
    } }).appState).toEqual(appState);
    expect(parseStep({ ...step, appState: {} }).appState).toEqual({});
    expect(() => parseStep({ ...step, appState: { gridSize: null } })).toThrow();
  });

  it('rejects malformed relied-on fields and preserves unvalidated geometry', () => {
    const step = fixture().scenes[0].steps[0];
    for (const change of [{ id: '' }, { type: '' }, { version: -1 }, { versionNonce: 0.5 }, { isDeleted: 'false' }, { fileId: '../image' }]) {
      expect(() => parseStep({ ...step, elements: [{ ...step.elements[0], ...change }] })).toThrow();
    }
    expect(parseStep(step).elements[0].x).toBe(10);
  });

  it('rejects unsafe document IDs and asset paths', () => {
    expect(() => createScene('Unsafe', { id: '../scene' })).toThrow();
    const step = fixture().scenes[0].steps[0];
    for (const path of ['../image-1.svg', '/assets/image-1.svg', 'assets/other.svg']) {
      expect(() => parseStep({ ...step, files: {
        'image-1': { ...step.files['image-1'], path },
      } })).toThrow();
    }
  });
});

describe('domain helpers', () => {
  it('creates valid empty documents with stable supplied values', () => {
    const project = createProject('New project', { id: 'p', now: '2026-11-07T12:00:00.000Z' });
    expect(project.createdAt).toBe(project.updatedAt);
    expect(validateProjectTree({ project, scenes: [] }).project.sceneIds).toEqual([]);
    expect(createScene('Empty', { id: 's' }).stepIds).toEqual([]);
    expect(createStep({ id: 't' })).toEqual({
      schemaVersion: 1, id: 't', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {},
    });
    expect(createStep().id).not.toBe(createStep().id);
  });

  it('duplicates a complete snapshot with new step ID and no shared references', () => {
    const source = fixture().scenes[0].steps[0];
    source.title = 'Title';
    source.speakerNotes = 'Notes';
    const before = structuredClone(source);
    const copy = duplicateStep(source, 'new-step');
    expect(copy).toEqual({ ...source, id: 'new-step' });
    expect(copy.elements.map(({ id }) => id)).toEqual(source.elements.map(({ id }) => id));
    expect(copy.elements[0]).not.toBe(source.elements[0]);
    const customData = copy.elements[0].customData as { nested: string[] };
    customData.nested.push('changed');
    copy.appState.viewBackgroundColor = '#000000';
    copy.files['image-1'].path = 'assets/image-1.png';
    expect(source).toEqual(before);
    expect(() => duplicateStep(source, source.id)).toThrow('new ID');
  });

  it('detaches caller-owned nested content when creating a step', () => {
    const source = fixture().scenes[0].steps[0];
    const created = createStep(source);
    expect(created).toEqual(source);
    expect(created.elements[0].customData).not.toBe(source.elements[0].customData);
    expect(created.files['image-1']).not.toBe(source.files['image-1']);
  });
});

describe('whole project validation', () => {
  it('accepts repeated element identities across steps and unordered child arrays', () => {
    const tree = fixture();
    tree.scenes[0].steps.reverse();
    expect(validateProjectTree(tree)).toEqual(tree);
  });

  it('allows null file IDs and extra manifest entries', () => {
    const tree = fixture();
    tree.scenes[0].steps[0].elements[0].fileId = null;
    expect(validateProjectTree(tree)).toEqual(tree);
  });

  const inconsistencies: [string, (tree: ProjectTree) => void, string][] = [
    ['duplicate scene order', (t) => t.project.sceneIds.push('scene-1'), 'Duplicate ordered ID'],
    ['missing scene child', (t) => t.project.sceneIds.push('absent'), 'has no child'],
    ['unlisted scene child', (t) => { t.project.sceneIds = []; }, 'missing from the order list'],
    ['duplicate step order', (t) => t.scenes[0].scene.stepIds.push('step-1'), 'Duplicate ordered ID'],
    ['missing step child', (t) => t.scenes[0].scene.stepIds.push('absent'), 'has no child'],
    ['unlisted step child', (t) => { t.scenes[0].scene.stepIds = ['step-1']; }, 'missing from the order list'],
    ['duplicate scene document', (t) => t.scenes.push(structuredClone(t.scenes[0])), 'Duplicate document ID'],
    ['duplicate step document', (t) => t.scenes[0].steps.push(structuredClone(t.scenes[0].steps[0])), 'Duplicate document ID'],
    ['cross-kind document collision', (t) => { t.project.id = 'scene-1'; }, 'Duplicate document ID'],
    ['duplicate element ID', (t) => t.scenes[0].steps[0].elements.push(structuredClone(t.scenes[0].steps[0].elements[0])), 'Duplicate element ID'],
    ['missing manifest entry', (t) => { t.scenes[0].steps[0].files = {}; }, 'has no manifest entry'],
    ['deleted image without manifest', (t) => {
      t.scenes[0].steps[0].elements[0].isDeleted = true;
      t.scenes[0].steps[0].files = {};
    }, 'has no manifest entry'],
    ['conflicting shared path', (t) => { t.scenes[0].steps[1].files['image-1'].path = 'assets/image-1.png'; }, 'Conflicting manifest'],
    ['conflicting shared MIME type', (t) => { t.scenes[0].steps[1].files['image-1'].mimeType = 'image/png'; }, 'Conflicting manifest'],
    ['conflicting shared creation time', (t) => { t.scenes[0].steps[1].files['image-1'].created = 2; }, 'Conflicting manifest'],
    ['conflicting shared binary version', (t) => { t.scenes[0].steps[1].files['image-1'].version = 2; }, 'Conflicting manifest'],
  ];

  it.each(inconsistencies)('catches %s', (_name, mutate, message) => {
    const tree = fixture();
    mutate(tree);
    expect(() => validateProjectTree(tree)).toThrow(message);
  });

  it('detects step ID collisions across scenes', () => {
    const tree = fixture();
    const other = createScene('Other', { id: 'scene-2' });
    other.stepIds = ['step-1'];
    tree.project.sceneIds.push(other.id);
    tree.scenes.push({ scene: other, steps: [structuredClone(tree.scenes[0].steps[0])] });
    expect(() => validateProjectTree(tree)).toThrow('Duplicate document ID');
  });

  it('returns issue paths for multiple independent errors', () => {
    const tree = fixture();
    tree.project.sceneIds.push('absent');
    tree.scenes[0].steps[0].files = {};
    const result = (() => {
      try { validateProjectTree(tree); } catch (error) { return error; }
    })();
    expect(result).toMatchObject({ issues: expect.arrayContaining([
      expect.objectContaining({ path: ['project', 'sceneIds', 1] }),
      expect.objectContaining({ path: ['scenes', 0, 'steps', 0, 'elements', 0, 'fileId'] }),
    ]) });
  });
});

describe('sample project on disk', () => {
  it('validates every discovered document and checks assets and filenames', async () => {
    const root = new URL('../../../examples/demo-project/', import.meta.url);
    const readJson = async (url: URL): Promise<unknown> => JSON.parse(await readFile(url, 'utf8'));
    const project = parseProject(await readJson(new URL('project.json', root)));
    const scenes: ProjectTree['scenes'] = [];
    const directories = await readdir(new URL('scenes/', root), { withFileTypes: true });
    for (const directory of directories) {
      expect(directory.isDirectory()).toBe(true);
      const sceneRoot = new URL(`scenes/${directory.name}/`, root);
      const scene = parseScene(await readJson(new URL('scene.json', sceneRoot)));
      expect(scene.id).toBe(directory.name);
      const files = await readdir(new URL('steps/', sceneRoot));
      const steps = [];
      for (const file of files) {
        const step = parseStep(await readJson(new URL(`steps/${file}`, sceneRoot)));
        expect(file).toBe(`${step.id}.json`);
        for (const asset of Object.values(step.files)) {
          expect((await readFile(fileURLToPath(new URL(asset.path, root)))).length).toBeGreaterThan(0);
        }
        steps.push(step);
      }
      scenes.push({ scene, steps });
    }
    const tree = validateProjectTree({ project, scenes });
    expect(tree.scenes).toHaveLength(2);
    const first = tree.scenes.find(({ scene }) => scene.id === project.sceneIds[0])!;
    expect(first.steps).toHaveLength(3);
    const ordered = first.scene.stepIds.map((id) => first.steps.find((step) => step.id === id)!);
    expect(ordered.map(({ elements }) => elements.length)).toEqual([3, 4, 6]);
    for (let index = 1; index < ordered.length; index++) {
      for (const element of ordered[index - 1].elements) {
        expect(ordered[index].elements.find(({ id }) => id === element.id)).toEqual(element);
      }
      expect(ordered[index].files).toEqual(ordered[0].files);
    }
  });
});
