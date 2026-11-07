import { describe, expect, it } from 'vitest';
import { createStep, parseStep } from '@paso/shared';
import { addElements, deleteElements, describeStep, updateElements } from './elements.js';
import { elementInput, elementPatch } from './input.js';
import { configuration } from './api.js';
import { measureText } from './font.js';

const drawing = () => addElements(createStep({ id: 'step' }), [
  { id: 'arrow', type: 'arrow', fromId: 'left', toId: 'right' },
  { id: 'left', type: 'rectangle', x: -200, y: 0, width: 40, height: 20, label: 'Árbol y evolución\nInformación', backgroundColor: '#e3f5cf' },
  { id: 'right', type: 'ellipse', x: 300, y: 20, label: 'Salida' },
]);

describe('simple Excalidraw elements', () => {
  it('makes complete documents, stable bindings and labels that fit each shape', () => {
    const step = drawing();
    expect(parseStep(step)).toEqual(step);
    const arrow = step.elements.find((element) => element.id === 'arrow')!;
    expect(arrow.startBinding).toEqual({ elementId: 'left', focus: 0, gap: 8 });
    expect(arrow.endBinding).toEqual({ elementId: 'right', focus: 0, gap: 8 });
    expect(arrow.points).toHaveLength(2);
    for (const type of ['rectangle', 'ellipse', 'diamond'] as const) {
      const result = addElements(createStep(), [{ type, id: 'box', x: 0, y: 0, width: 5, height: 5, label: 'Una etiqueta larga\nÁÉÍÓÚ, ü y ñ' }]);
      const [shape, label] = result.elements;
      const factor = type === 'diamond' ? 2 : type === 'ellipse' ? Math.SQRT2 : 1;
      expect(Number(shape.width) / factor - 10).toBeGreaterThan(Number(label.width));
      expect(Number(shape.height) / factor - 10).toBeGreaterThan(Number(label.height));
      expect(label.containerId).toBe(shape.id);
      expect(shape.boundElements).toEqual([{ id: label.id, type: 'text' }]);
      expect(result.elements.every((element) => typeof element.index === 'string')).toBe(true);
    }
  });
  it('preserves unknown fields and changes metadata exactly once for affected elements', () => {
    const step = drawing();
    const left = step.elements.find((element) => element.id === 'left')!;
    const right = step.elements.find((element) => element.id === 'right')!;
    const arrow = step.elements.find((element) => element.id === 'arrow')!;
    left.future = { nested: ['keep', { value: 7 }] };
    (left.boundElements as { id: string; future?: unknown }[]).find((bound) => bound.id === 'arrow')!.future = { keep: true };
    arrow.startBinding = { ...arrow.startBinding as object, future: { keep: true } };
    const result = updateElements(step, [{ id: 'left', x: -100, label: 'Nuevo texto' }]);
    for (const original of step.elements) {
      const current = result.elements.find((element) => element.id === original.id)!;
      if (JSON.stringify(current) !== JSON.stringify(original)) {
        expect(current.version).toBe(original.version + 1);
        expect(current.versionNonce).not.toBe(original.versionNonce);
        expect(current.seed).toBe(original.seed);
      }
    }
    expect(result.elements.find((element) => element.id === 'left')!.future).toEqual(left.future);
    expect(result.elements.find((element) => element.id === 'left')!.boundElements).toEqual(left.boundElements);
    expect(result.elements.find((element) => element.id === 'arrow')!.startBinding).toEqual(arrow.startBinding);
    expect(result.elements.find((element) => element.id === 'right')).toEqual(right);
    expect(step.elements.find((element) => element.id === 'left')!.x).toBe(-200);
    expect(result.elements.find((element) => element.id === 'arrow')!.points).not.toEqual(arrow.points);
  });
  it('retargets arrows and removes only obsolete reciprocal bindings', () => {
    const step = addElements(drawing(), [{ type: 'diamond', id: 'third', x: 600, y: 40, label: 'Final' }]);
    const result = updateElements(step, [{ id: 'arrow', toId: 'third' }]);
    expect(result.elements.find((element) => element.id === 'right')!.boundElements).not.toContainEqual({ id: 'arrow', type: 'arrow' });
    expect(result.elements.find((element) => element.id === 'third')!.boundElements).toContainEqual({ id: 'arrow', type: 'arrow' });
    expect(result.elements.find((element) => element.id === 'arrow')!.endBinding).toEqual({ elementId: 'third', focus: 0, gap: 8 });
  });
  it('retains unsupported elements and the alignment of existing labels', () => {
    const step = drawing();
    const label = step.elements.find((element) => element.containerId === 'left')!;
    label.textAlign = 'left'; label.verticalAlign = 'top';
    step.elements.push({ id: 'future', type: 'future-widget', version: 12, versionNonce: -8, isDeleted: false, future: { payload: ['keep'] } });
    const result = updateElements(step, [{ id: 'left', x: 10, y: 20 }]);
    expect(result.elements.at(-1)).toEqual(step.elements.at(-1));
    const movedLabel = result.elements.find((element) => element.id === label.id)!;
    expect(movedLabel.x).toBe(15); expect(movedLabel.y).toBe(25);
    expect(movedLabel.textAlign).toBe('left'); expect(movedLabel.verticalAlign).toBe('top');
  });
  it('keeps metadata unchanged for a no-op patch and supports reverse arrows', () => {
    const step = drawing();
    expect(updateElements(step, [{ id: 'left', x: -200 }])).toEqual(step);
    const result = addElements(step, [{ type: 'arrow', id: 'reverse', fromId: 'right', toId: 'left' }]);
    const reverse = result.elements.find((element) => element.id === 'reverse')!;
    expect((reverse.points as number[][])[1][0]).toBeLessThan(0);
    expect(Number(reverse.width)).toBeGreaterThan(0);
    expect(reverse.startBinding).toEqual({ elementId: 'right', focus: 0, gap: 8 });
  });
  it('deletes shapes, bound labels and connected arrows, and retains unrelated data', () => {
    const step = drawing();
    const result = deleteElements(step, ['left']);
    expect(result.elements.filter((element) => element.isDeleted).map((element) => element.type).sort()).toEqual(['arrow', 'rectangle', 'text']);
    const right = result.elements.find((element) => element.id === 'right')!;
    expect(right.boundElements).not.toContainEqual({ id: 'arrow', type: 'arrow' });
    expect(result.elements.find((element) => element.containerId === 'right')!.isDeleted).toBe(false);
    expect(() => addElements(result, [{ type: 'text', id: 'left', x: 0, y: 0, text: 'Reuse' }])).toThrow('DUPLICATE_ID');
  });
  it('edits standalone text and removes or restores shape labels', () => {
    const step = addElements(drawing(), [{ type: 'text', id: 'caption', x: 0, y: -100, text: 'Antes' }]);
    const changed = updateElements(step, [{ id: 'caption', text: 'Después\nNueva línea', fontSize: 32 }, { id: 'right', label: null }]);
    const caption = changed.elements.find((element) => element.id === 'caption')!;
    expect(caption.text).toBe('Después\nNueva línea');
    expect(caption.height).toBe(32 * 1.15 * 2);
    expect(changed.elements.find((element) => element.containerId === 'right')!.isDeleted).toBe(true);
    expect(updateElements(changed, [{ id: 'right', label: 'Restaurada' }]).elements.some((element) => element.containerId === 'right' && !element.isDeleted)).toBe(true);
  });
  it('rejects unsupported changes without mutating input', () => {
    const step = drawing();
    const saved = JSON.stringify(step);
    expect(() => updateElements(step, [{ id: 'missing', x: 1 }])).toThrow('ELEMENT_NOT_FOUND');
    expect(() => updateElements(step, [{ id: 'left', text: 'Wrong' }])).toThrow('INVALID_PROPERTY');
    expect(() => addElements(step, [{ type: 'arrow', id: 'broken', fromId: 'left', toId: 'missing' }])).toThrow('ELEMENT_NOT_FOUND');
    expect(() => addElements(step, [{ type: 'arrow', id: 'broken', fromId: 'left', toId: 'left' }])).toThrow('INVALID_BINDING');
    expect(() => updateElements(step, [{ id: String(step.elements.find((element) => element.containerId === 'left')!.id), text: 'Wrong' }])).toThrow('BOUND_LABEL');
    expect(() => updateElements(step, [{ id: 'left', x: 10 }, { id: 'left', y: 20 }])).toThrow('DUPLICATE_ID');
    expect(JSON.stringify(step)).toBe(saved);
    step.elements.find((element) => element.id === 'arrow')!.elbowed = true;
    expect(() => updateElements(step, [{ id: 'left', x: 30 }])).toThrow('UNSUPPORTED_ARROW');
  });
  it('returns useful layout and potential shape overlap information', () => {
    const step = addElements(createStep(), [
      { type: 'rectangle', id: 'one', x: 0, y: 0, label: 'Uno' },
      { type: 'rectangle', id: 'two', x: 20, y: 20, label: 'Dos' },
    ]);
    const result = describeStep(step, 'revision');
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0].label).toBe('Uno');
    expect(result.overlaps).toEqual([['one', 'two']]);
  });
});

describe('validation and configuration', () => {
  it('normalizes Spanish text and rejects unmeasurable glyphs or controls', () => {
    expect(measureText('a\u0301\tñ\r\nü', 24).text).toBe('á        ñ\nü');
    expect(() => measureText('🦄', 24)).toThrow('UNSUPPORTED_TEXT');
    expect(() => measureText('a\u0000b', 24)).toThrow('UNSUPPORTED_TEXT');
  });
  it.each([
    { type: 'text', id: 'text', x: 0, y: 0, text: 'Hola', seed: 7 },
    { type: 'rectangle', id: '../escape', x: 0, y: 0 },
    { type: 'rectangle', id: 'shape', x: 0, y: 0, width: -1 },
    { type: 'text', id: 'text', x: Infinity, y: 0, text: 'Hola' },
    { type: 'text', id: 'text', x: 0, y: 0, text: 'Hola', fontSize: 0 },
    { type: 'arrow', id: 'arrow', fromId: 'one' },
  ])('rejects malformed element input %j', (input) => expect(elementInput.safeParse(input).success).toBe(false));
  it('rejects empty patches and internal fields', () => {
    expect(elementPatch.safeParse({ id: 'one' }).success).toBe(false);
    expect(elementPatch.safeParse({ id: 'one', versionNonce: 9 }).success).toBe(false);
  });
  it('requires a token and confines service access to a loopback origin', () => {
    expect(() => configuration({})).toThrow('PASO_SESSION_TOKEN');
    expect(() => configuration({ PASO_SESSION_TOKEN: 'short' })).toThrow('PASO_SESSION_TOKEN');
    for (const url of ['https://127.0.0.1:3001', 'http://example.org', 'http://127.0.0.1/api', 'http://user:secret@localhost', 'http://localhost/?token=secret']) {
      expect(() => configuration({ PASO_SESSION_TOKEN: 'x'.repeat(32), PASO_SERVICE_URL: url })).toThrow('PASO_SERVICE_URL');
    }
    expect(configuration({ PASO_SESSION_TOKEN: 'x'.repeat(32) }).serviceUrl).toBe('http://127.0.0.1:3001');
    expect(() => configuration({ PASO_SESSION_TOKEN: 'x'.repeat(32), PASO_MCP_BROWSER_EXECUTABLE: 'relative' })).toThrow('absolute path');
  });
});
