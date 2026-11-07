// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStep } from '@paso/shared';
import { ThumbnailCache } from './thumbnails';
import type { ApiClient } from '../lib/api';
const mocks = vi.hoisted(() => ({ exportToSvg: vi.fn(async () => ({ outerHTML: '<svg />' })), loadDrawingFonts: vi.fn(async () => {}) }));
vi.mock('./excalidraw-runtime', () => ({
  canvasElements: (step: { elements: unknown[] }) => step.elements,
  canvasFiles: (files: unknown) => files,
  loadDrawingFonts: mocks.loadDrawingFonts,
  excalidraw: async () => ({
    restoreElements: (elements: unknown[]) => elements,
    getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [Math.min(...elements.map((e) => e.x)), Math.min(...elements.map((e) => e.y)), Math.max(...elements.map((e) => e.x + e.width)), Math.max(...elements.map((e) => e.y + e.height))],
    convertToExcalidrawElements: (elements: unknown[]) => elements,
    exportToSvg: mocks.exportToSvg,
  }),
}));
vi.mock('./assets', () => ({ loadFiles: async () => ({}) }));
beforeEach(() => { vi.clearAllMocks(); });
describe('thumbnail revision cache', () => {
  it('uses one camera per scene, keeps tombstones out, awaits fonts and uses the export theme', async () => {
    const element = { id: 'x', type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 100, y: 100, width: 100, height: 100 };
    const steps = [{ document: createStep({ id: 'a', elements: [element] }), revision: 'a1' }, { document: createStep({ id: 'b', elements: [{ ...element, id: 'y', x: -500 }, { ...element, id: 'gone', x: 99999, isDeleted: true }] }), revision: 'b1' }];
    const api = { config: { baseUrl: 'local' }, listSteps: vi.fn(async () => steps) } as unknown as ApiClient;
    const cache = new ThumbnailCache(); const first = await cache.scene(api, 'p', 's', 'dark');
    expect(first[0].bounds).toEqual(first[1].bounds); expect(first[0].bounds[2]).toBeLessThan(1000);
    expect(mocks.loadDrawingFonts.mock.invocationCallOrder[0]).toBeLessThan(mocks.exportToSvg.mock.invocationCallOrder[0]);
    expect(mocks.exportToSvg).toHaveBeenCalledWith(expect.objectContaining({ appState: expect.objectContaining({ exportWithDarkMode: true }), exportPadding: 0 }));
    await cache.scene(api, 'p', 's', 'dark'); expect(mocks.exportToSvg).toHaveBeenCalledTimes(2);
    // A step whose revision did not change keeps its export while the camera is the same.
    steps[1].revision = 'b2'; await cache.scene(api, 'p', 's', 'dark'); expect(mocks.exportToSvg).toHaveBeenCalledTimes(3);
    // A change that moves the common camera exports every step again.
    steps[1].document.elements.push({ ...element, id: 'far', x: 5000 }); steps[1].revision = 'b3';
    await cache.scene(api, 'p', 's', 'dark'); expect(mocks.exportToSvg).toHaveBeenCalledTimes(5);
    await cache.scene(api, 'p', 's', 'light'); expect(mocks.exportToSvg).toHaveBeenCalledTimes(7);
    cache.clear(); await cache.scene(api, 'p', 's', 'light'); expect(mocks.exportToSvg).toHaveBeenCalledTimes(9);
  });
});
