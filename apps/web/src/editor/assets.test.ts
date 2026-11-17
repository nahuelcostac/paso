// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStep, type Step } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import { loadFiles } from './assets';

const entry = { path: 'assets/img1.png', mimeType: 'image/png', created: 1 };
const step = (id: string): Step => ({ ...createStep({ id }), files: { img1: entry } });

describe('images on the canvas', () => {
  it('reads an image once for every step that shows it, and tries again after a failure', async () => {
    let fail = true;
    const asset = vi.fn(async () => { if (fail) { fail = false; throw new Error('offline'); } return new Response(new Uint8Array([1, 2, 3])); });
    const api = { asset } as unknown as ApiClient;
    await expect(loadFiles(api, 'p', step('a'))).rejects.toThrow('offline');
    const first = await loadFiles(api, 'p', step('a'));
    const second = await loadFiles(api, 'p', step('b'));
    expect(asset).toHaveBeenCalledTimes(2);
    expect(first.img1).toEqual(second.img1);
    expect(first.img1).toMatchObject({ id: 'img1', mimeType: 'image/png', created: 1 });
    expect(first.img1.dataURL).toMatch(/^data:image\/png;base64,/);
    // Each caller gets its own copy: changing one never reaches another step.
    expect(first.img1).not.toBe(second.img1);
  });
  it('keeps an unsaved image of the step itself, without reading it', async () => {
    const asset = vi.fn();
    const local = { img1: { id: 'img1', dataURL: 'data:image/png;base64,AA==', mimeType: 'image/png', created: 1 } };
    expect(await loadFiles({ asset } as unknown as ApiClient, 'p', step('a'), local)).toEqual(local);
    expect(asset).not.toHaveBeenCalled();
  });
});
