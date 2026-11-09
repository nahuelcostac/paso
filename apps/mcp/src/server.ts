import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { idSchema, type Scene, type Project, type Step } from '@paso/shared';
import { BoardApi, scenePath, stepPath, type Configuration, type Envelope } from './api.js';
import { addElements, updateElements, deleteElements, describeStep } from './elements.js';
import { elementInput, elementPatch, revisionSchema, targetShape, type Target } from './input.js';
import { renderStep } from './image.js';

const textResult = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const conventions = 'Canvas units are pixels. x increases right, y down. x/y is the top-left, not the center. Width/height are positive minimum sizes. Labels use the bundled Excalifont font and grow containers to fit without wrapping; use \\n for line breaks. IDs are stable and unique within a step. Straight arrows bind shape IDs and follow moved shapes. New shapes and arrows use artist roughness. No raw Excalidraw properties are accepted.';
const stale = 'Pass the exact unquoted revision returned by read_step. On REVISION_CONFLICT read again and reconsider edits. Writes are atomic per step and never automatically retried.';

export function createBoardMcp(config: Configuration) {
  const api = new BoardApi(config);
  const server = new McpServer({ name: 'paso-board', version: '0.1.0' }, {
    instructions: `Paso is a local whiteboard with project > scenes > steps. Each step is a full independent snapshot. List projects first. Create scenes and steps in an existing project, then add elements. Duplicate a step to build up an explanation without changing previous steps. ${conventions} ${stale} Call get_step_image after drawing; if unavailable, inspect read_step layout and overlaps or ask for a visual check in Paso.`,
  });
  function tool<Schema extends z.ZodRawShape>(name: string, description: string, inputSchema: Schema, readOnly: boolean, handler: (input: z.infer<z.ZodObject<Schema>>) => Promise<unknown>, destructive = false) {
    server.registerTool<z.ZodRawShape, z.ZodObject<Schema>>(name, { description, inputSchema: z.object(inputSchema).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false } }, async (input) => {
      try { return textResult(await handler(input as z.infer<z.ZodObject<Schema>>)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'BOARD_ERROR. The board operation failed. Read current state before retrying.' }] }; }
    });
  }
  tool('list_projects', 'List existing Paso projects. Invalid projects include a service error. There is no project creation or deletion tool.', {}, true, () => api.request('/api/projects'));
  tool('read_project', 'Read a project and its ordered scene documents with revisions. Use read_scene to list a scene’s steps.', { projectId: idSchema }, true, async ({ projectId }) => ({
    ...await api.request<Envelope<Project>>(`/api/projects/${projectId}`),
    ...await api.request<{ scenes: Envelope<Scene>[] }>(scenePath(projectId)),
  }));
  tool('read_scene', 'Read a scene and its ordered steps, titles, element counts and step revisions. Use read_step before editing a step.', { projectId: idSchema, sceneId: idSchema }, true, async ({ projectId, sceneId }) => {
    const scene = await api.request<Envelope<Scene>>(scenePath(projectId, sceneId));
    const { steps } = await api.request<{ steps: Envelope<Step>[] }>(`${scenePath(projectId, sceneId)}/steps`);
    return { ...scene, steps: steps.map(({ document, revision }) => ({ stepId: document.id, title: document.title, revision, elementCount: document.elements.filter((element) => !element.isDeleted).length })) };
  });
  tool('read_step', `Read a step’s current revision and simple layout with positions, sizes, labels, connections and potential overlaps. ${conventions}`, targetShape, true, async (target) => {
    const { document, revision } = await api.readStep(target); return describeStep(document, revision);
  });
  tool('create_scene', 'Append an empty scene to an existing project. Optional id is project-wide unique. The service appends safely under its project lock. On uncertain transport failure, read_project before retrying.', { projectId: idSchema, name: z.string().min(1).max(500), id: idSchema.optional() }, false, ({ projectId, ...input }) => api.request(scenePath(projectId), 'POST', input));
  tool('create_step', 'Append an empty full-snapshot step to a scene. Optional id is project-wide unique. Use duplicate_step instead to build on a previous drawing. On uncertain transport failure, read_scene before retrying.', { projectId: idSchema, sceneId: idSchema, id: idSchema.optional(), title: z.string().max(500).optional(), speakerNotes: z.string().max(20_000).optional() }, false, ({ projectId, sceneId, ...input }) => api.request(`${scenePath(projectId, sceneId)}/steps`, 'POST', input));
  tool('duplicate_step', `Append a full copy to the same scene. Keep all element IDs, unknown properties and assets. Optional id is the NEW step ID, not an element ID. ${stale}`, { ...targetShape, revision: revisionSchema, id: idSchema.optional() }, false, ({ revision, id, ...target }) => api.request(`${stepPath(target)}/duplicate`, 'POST', id ? { id } : {}, revision));
  async function edit(target: Target, revision: string, change: (step: Step) => Step) {
    const current = await api.readStep(target);
    if (current.revision !== revision) throw new Error('REVISION_CONFLICT. The step changed. Call read_step again and reconsider your edits. No change was written.');
    const saved = await api.request<Envelope<Step>>(stepPath(target), 'PUT', change(current.document), revision);
    return describeStep(saved.document, saved.revision);
  }
  tool('add_elements', `Add up to 200 shapes, labels, text and straight arrows in one step write. Supply each new element’s id. Arrows use fromId and toId, which may refer to shapes added in the same batch, in any order. Shape defaults are 180×90 and fontSize 24. ${conventions} ${stale}`, { ...targetShape, revision: revisionSchema, elements: z.array(elementInput).min(1).max(200) }, false, ({ revision, elements, ...target }) => edit(target, revision, (step) => addElements(step, elements)));
  tool('update_elements', `Patch properties by element id. Omitted fields stay unchanged, including unknown Excalidraw data. Use label:null to remove a shape label. Text uses text; shape labels use label. Geometry edits also move bound labels and straight center-bound arrows. Rotated, locked, grouped, framed or complex bound elements must be edited in Paso. ${conventions} ${stale}`, { ...targetShape, revision: revisionSchema, elements: z.array(elementPatch).min(1).max(200) }, false, ({ revision, elements, ...target }) => edit(target, revision, (step) => updateElements(step, elements)));
  tool('delete_elements', `Delete only elements in this step, leaving tombstones. Deleting a shape also deletes its bound labels and connected arrows. Clean reciprocal bindings. Other steps stay unchanged. ${stale}`, { ...targetShape, revision: revisionSchema, ids: z.array(z.string().min(1).max(256)).min(1).max(200) }, false, ({ revision, ids, ...target }) => edit(target, revision, (step) => deleteElements(step, ids)), true);
  server.registerTool('get_step_image', {
    description: 'Get a PNG of the current step from the real local Excalidraw exporter, at most 2048 pixels on the longest side. No Paso window is needed. Requires the host to configure PASO_MCP_BROWSER_EXECUTABLE with installed Chromium. No browser is downloaded. If unavailable, returns an error plus the read_step layout with positions and potential overlaps. Images and layout refer to the included revision, which may change later.',
    inputSchema: z.object(targetShape).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (target) => {
    let current: Envelope<Step> | undefined;
    try {
      current = await api.readStep(target);
      const data = await renderStep(api, target.projectId, current.document);
      return { content: [{ type: 'text', text: JSON.stringify({ revision: current.revision, stepId: current.document.id }) }, { type: 'image', data, mimeType: 'image/png' }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'IMAGE_UNAVAILABLE. Use read_step or open the step in Paso.', ...(current ? { layout: describeStep(current.document, current.revision) } : {}) }) }] };
    }
  });
  return server;
}
