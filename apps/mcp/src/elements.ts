import { randomInt, randomUUID } from 'node:crypto';
import { generateKeyBetween } from 'fractional-indexing';
import type { ExcalidrawElement as Element, Step } from '@paso/shared';
import { lineHeightForFont, measureText } from './font.js';
import type { ElementInput, ElementPatch } from './input.js';

type Binding = { elementId: string; focus: number; gap: number };
type Bound = { id: string; type: string; [key: string]: unknown };
const shapes = new Set(['rectangle', 'ellipse', 'diamond']);
const number = (element: Element, key: string) => {
  const value = element[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`UNSUPPORTED_ELEMENT. ${element.id} has no valid ${key}. Edit it in Paso.`);
  return value;
};
const bound = (element: Element) => (element.boundElements ?? []) as Bound[];
const binding = (element: Element, key: string) => element[key] as Binding | null | undefined;
const live = (elements: Element[], id: string) => {
  const element = elements.find((candidate) => candidate.id === id && !candidate.isDeleted);
  if (!element) throw new Error(`ELEMENT_NOT_FOUND. No live element with ID ${id}. Read the step again.`);
  return element;
};
const unique = (ids: string[]) => {
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ID. Each element ID must occur once in the batch.');
};

function base(id: string, type: string): Element {
  return {
    id, type, x: 0, y: 0, width: 0, height: 0, angle: 0,
    strokeColor: '#1b1b1f', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed: randomInt(1, 2 ** 31),
    version: 1, versionNonce: randomInt(1, 2 ** 31), isDeleted: false,
    boundElements: null, updated: Date.now(), link: null, locked: false,
  };
}
function textElement(id: string, text: string, fontSize: number, containerId: string | null): Element {
  return {
    ...base(id, 'text'), ...measureText(text, fontSize), fontSize, fontFamily: 5,
    textAlign: containerId ? 'center' : 'left', verticalAlign: containerId ? 'middle' : 'top',
    containerId, originalText: measureText(text, fontSize).text, autoResize: true, lineHeight: 1.25,
  };
}
function editable(element: Element) {
  if (!shapes.has(element.type) && element.type !== 'text' && element.type !== 'arrow') throw new Error(`UNSUPPORTED_ELEMENT. Edit ${element.type} in the Paso app. Other elements are preserved.`);
  if (element.angle !== 0 || element.frameId || (element.groupIds as unknown[] | undefined)?.length || element.locked) {
    throw new Error(`UNSUPPORTED_ELEMENT. ${element.id} is rotated, grouped, framed or locked. Edit it in the Paso app.`);
  }
}
function layoutLabel(elements: Element[], shape: Element) {
  const label = elements.find((element) => !element.isDeleted && element.type === 'text' && element.containerId === shape.id);
  if (!label) return;
  const factor = shape.type === 'diamond' ? 2 : shape.type === 'ellipse' ? Math.SQRT2 : 1;
  shape.width = Math.max(number(shape, 'width'), Math.ceil((number(label, 'width') + 24) * factor));
  shape.height = Math.max(number(shape, 'height'), Math.ceil((number(label, 'height') + 24) * factor));
  if (number(shape, 'width') > 20_000 || number(shape, 'height') > 20_000) throw new Error('LABEL_TOO_LARGE. Split the label into shorter lines.');
  const innerWidth = (factor === 1 ? number(shape, 'width') : Math.round(number(shape, 'width') / factor)) - 10;
  const innerHeight = (factor === 1 ? number(shape, 'height') : Math.round(number(shape, 'height') / factor)) - 10;
  const offsetX = 5 + number(shape, 'width') * (1 - 1 / factor) / 2;
  const offsetY = 5 + number(shape, 'height') * (1 - 1 / factor) / 2;
  label.x = number(shape, 'x') + offsetX + (label.textAlign === 'left' ? 0 : label.textAlign === 'right' ? innerWidth - number(label, 'width') : (innerWidth - number(label, 'width')) / 2);
  label.y = number(shape, 'y') + offsetY + (label.verticalAlign === 'top' ? 0 : label.verticalAlign === 'bottom' ? innerHeight - number(label, 'height') : (innerHeight - number(label, 'height')) / 2);
}
function setLabel(elements: Element[], shape: Element, text: string | null, fontSize?: number) {
  let label = elements.find((element) => !element.isDeleted && element.type === 'text' && element.containerId === shape.id);
  if (text === null) {
    if (label) { label.isDeleted = true; shape.boundElements = bound(shape).filter((item) => item.id !== label!.id); }
    return;
  }
  if (label) {
    const size = fontSize ?? number(label, 'fontSize');
    const family = number(label, 'fontFamily');
    const measured = measureText(text, size, family);
    Object.assign(label, measured, { fontSize: size, lineHeight: lineHeightForFont(family), originalText: measured.text, autoResize: true });
  }
  else {
    label = textElement(randomUUID(), text, fontSize ?? 24, shape.id);
    label.strokeColor = shape.strokeColor;
    elements.push(label);
    shape.boundElements = [...bound(shape), { id: label.id, type: 'text' }];
  }
  layoutLabel(elements, shape);
}
function endpoint(shape: Element, other: Element): [number, number] {
  editable(shape);
  if (!shapes.has(shape.type)) throw new Error('INVALID_BINDING. Arrows must connect two rectangle, ellipse or diamond IDs.');
  const halfWidth = number(shape, 'width') / 2, halfHeight = number(shape, 'height') / 2;
  const centerX = number(shape, 'x') + halfWidth, centerY = number(shape, 'y') + halfHeight;
  const deltaX = number(other, 'x') + number(other, 'width') / 2 - centerX;
  const deltaY = number(other, 'y') + number(other, 'height') / 2 - centerY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 1) throw new Error('INVALID_BINDING. Connected shapes must have different centers. Move one shape first.');
  const ratio = shape.type === 'ellipse'
    ? 1 / Math.hypot(deltaX / halfWidth, deltaY / halfHeight)
    : shape.type === 'diamond' ? 1 / (Math.abs(deltaX) / halfWidth + Math.abs(deltaY) / halfHeight)
      : Math.min(halfWidth / Math.abs(deltaX), halfHeight / Math.abs(deltaY));
  return [centerX + deltaX * ratio + deltaX / distance * 8, centerY + deltaY * ratio + deltaY / distance * 8];
}
function connect(elements: Element[], arrow: Element, fromId: string, toId: string) {
  editable(arrow);
  if (arrow.elbowed || !Array.isArray(arrow.points) || arrow.points.length !== 2 || bound(arrow).length ||
    ['startBinding', 'endBinding'].some((key) => binding(arrow, key) && binding(arrow, key)!.focus !== 0)) {
    throw new Error('UNSUPPORTED_ARROW. Only straight, unlabeled, center-bound arrows can be rerouted. Move this shape or arrow in Paso instead.');
  }
  const from = live(elements, fromId), to = live(elements, toId);
  const start = endpoint(from, to), end = endpoint(to, from);
  for (const shape of elements) {
    if (shape !== from && shape !== to && bound(shape).some((item) => item.id === arrow.id)) shape.boundElements = bound(shape).filter((item) => item.id !== arrow.id);
  }
  arrow.x = start[0]; arrow.y = start[1];
  arrow.width = Math.abs(end[0] - start[0]); arrow.height = Math.abs(end[1] - start[1]);
  arrow.points = [[0, 0], [end[0] - start[0], end[1] - start[1]]];
  arrow.startBinding = { ...binding(arrow, 'startBinding'), elementId: fromId, focus: 0, gap: 8 };
  arrow.endBinding = { ...binding(arrow, 'endBinding'), elementId: toId, focus: 0, gap: 8 };
  for (const shape of [from, to]) if (!bound(shape).some((item) => item.id === arrow.id)) shape.boundElements = [...bound(shape), { id: arrow.id, type: 'arrow' }];
}
function finalize(before: Step, elements: Element[]) {
  let previousIndex: string | null = null;
  for (const element of elements) {
    const original = before.elements.find((candidate) => candidate.id === element.id);
    if (!original) element.index = generateKeyBetween(previousIndex, null);
    if (typeof element.index === 'string') previousIndex = element.index;
    if (original && JSON.stringify(element) !== JSON.stringify(original)) {
      element.version = original.version + 1;
      do { element.versionNonce = randomInt(1, 2 ** 31); } while (element.versionNonce === original.versionNonce);
      element.updated = Math.max(Date.now(), typeof original.updated === 'number' ? original.updated + 1 : 0);
    }
  }
  return { ...before, elements };
}

export function addElements(step: Step, inputs: ElementInput[]): Step {
  unique(inputs.map((input) => input.id));
  const elements = structuredClone(step.elements);
  for (const input of inputs) {
    if (elements.some((element) => element.id === input.id)) throw new Error(`DUPLICATE_ID. ${input.id} already exists, including tombstones. Use a new ID.`);
    const { id, type, ...properties } = input;
    if (input.type === 'arrow') elements.push({ ...base(id, type), points: [[0, 0], [0, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false });
    else if (input.type === 'text') elements.push({ ...textElement(id, input.text, input.fontSize ?? 24, null), x: input.x, y: input.y });
    else elements.push({ ...base(id, type), x: input.x, y: input.y, width: input.width ?? 180, height: input.height ?? 90 });
    const element = elements.at(-1)!;
    for (const key of ['strokeColor', 'backgroundColor', 'strokeWidth', 'opacity'] as const) if (key in properties) element[key] = properties[key as keyof typeof properties];
  }
  for (const input of inputs) if (shapes.has(input.type) && 'label' in input && input.label) setLabel(elements, live(elements, input.id), input.label, input.fontSize);
  for (const input of inputs) if (input.type === 'arrow') connect(elements, live(elements, input.id), input.fromId, input.toId);
  return finalize(step, elements);
}

export function updateElements(step: Step, patches: ElementPatch[]): Step {
  unique(patches.map((patch) => patch.id));
  const elements = structuredClone(step.elements);
  const movedShapes = new Set<string>();
  for (const patch of patches) {
    const element = live(elements, patch.id);
    editable(element);
    const isShape = shapes.has(element.type);
    for (const key of Object.keys(patch).filter((key) => key !== 'id')) {
      const allowed = ['strokeColor', 'strokeWidth', 'opacity', ...(element.type === 'arrow' ? ['fromId', 'toId'] : ['x', 'y', 'backgroundColor', 'fontSize', ...(isShape ? ['width', 'height', 'label'] : ['text'])])];
      if (!allowed.includes(key)) throw new Error(`INVALID_PROPERTY. ${key} cannot be changed on ${element.type}.`);
    }
    if (element.type === 'text' && element.containerId) throw new Error('BOUND_LABEL. Update the parent shape using label and fontSize, not its bound text ID.');
    for (const key of ['x', 'y', 'width', 'height', 'strokeColor', 'backgroundColor', 'strokeWidth', 'opacity'] as const) if (patch[key] !== undefined) element[key] = patch[key];
    if (isShape) {
      if (patch.label !== undefined) setLabel(elements, element, patch.label, patch.fontSize);
      else if (patch.fontSize !== undefined) {
        const label = elements.find((candidate) => !candidate.isDeleted && candidate.containerId === element.id);
        if (!label) throw new Error('LABEL_REQUIRED. Set label when adding a fontSize to an unlabeled shape.');
        setLabel(elements, element, String(label.originalText ?? label.text), patch.fontSize);
      }
      layoutLabel(elements, element);
      if (['x', 'y', 'width', 'height', 'label', 'fontSize'].some((key) => Object.hasOwn(patch, key))) movedShapes.add(element.id);
    } else if (element.type === 'text' && (patch.text !== undefined || patch.fontSize !== undefined)) {
      const family = number(element, 'fontFamily');
      const measured = measureText(patch.text ?? String(element.originalText ?? element.text), patch.fontSize ?? number(element, 'fontSize'), family);
      Object.assign(element, measured, { originalText: measured.text, fontSize: patch.fontSize ?? element.fontSize, lineHeight: lineHeightForFont(family), autoResize: true });
    }
  }
  for (const arrow of elements.filter((element) => element.type === 'arrow' && !element.isDeleted)) {
    const patch = patches.find((candidate) => candidate.id === arrow.id);
    const fromId = patch?.fromId ?? binding(arrow, 'startBinding')?.elementId;
    const toId = patch?.toId ?? binding(arrow, 'endBinding')?.elementId;
    if (patch?.fromId || patch?.toId || movedShapes.has(fromId ?? '') || movedShapes.has(toId ?? '')) {
      if (!fromId || !toId) throw new Error('UNSUPPORTED_ARROW. Both arrow ends must bind shapes. Move this shape in Paso instead.');
      connect(elements, arrow, fromId, toId);
    }
  }
  return finalize(step, elements);
}

export function deleteElements(step: Step, ids: string[]): Step {
  unique(ids);
  const elements = structuredClone(step.elements);
  for (const id of ids) live(elements, id);
  const removed = new Set(ids);
  for (const element of elements) if (element.type === 'arrow' && ['startBinding', 'endBinding'].some((key) => removed.has(binding(element, key)?.elementId ?? ''))) removed.add(element.id);
  for (const element of elements) if (typeof element.containerId === 'string' && removed.has(element.containerId)) removed.add(element.id);
  for (const element of elements) {
    if (removed.has(element.id)) element.isDeleted = true;
    if (bound(element).some((item) => removed.has(item.id))) element.boundElements = bound(element).filter((item) => !removed.has(item.id));
  }
  return finalize(step, elements);
}

export function describeStep(step: Step, revision: string) {
  const elements = step.elements.filter((element) => !element.isDeleted);
  const boxes = elements.filter((element) => !element.containerId).map((element) => ({
    id: element.id, type: element.type, x: element.x, y: element.y, width: element.width, height: element.height,
    angle: element.angle, text: element.text, fontSize: element.fontSize,
    strokeColor: element.strokeColor, backgroundColor: element.backgroundColor, opacity: element.opacity,
    label: elements.find((candidate) => candidate.type === 'text' && candidate.containerId === element.id)?.text,
    fromId: binding(element, 'startBinding')?.elementId, toId: binding(element, 'endBinding')?.elementId,
    editable: (shapes.has(element.type) || element.type === 'text' || element.type === 'arrow') && element.angle === 0 && !element.frameId && !(element.groupIds as unknown[] | undefined)?.length && !element.locked,
  }));
  const overlaps: string[][] = [];
  const containers = elements.filter((element) => shapes.has(element.type));
  for (let first = 0; first < containers.length; first++) for (let second = first + 1; second < containers.length; second++) {
    const left = containers[first], right = containers[second];
    if (Number(left.x) < Number(right.x) + Number(right.width) && Number(left.x) + Number(left.width) > Number(right.x) &&
      Number(left.y) < Number(right.y) + Number(right.height) && Number(left.y) + Number(left.height) > Number(right.y)) overlaps.push([left.id, right.id]);
  }
  return { stepId: step.id, title: step.title, speakerNotes: step.speakerNotes, revision, elements: boxes, overlaps,
    layoutNote: 'Coordinates are canvas pixels, x right, y down, x/y at the top-left. Overlaps are axis-aligned shape bounding-box intersections, not a full visual check. Read the step again after any conflict.' };
}
