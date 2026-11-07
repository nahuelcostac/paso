import { describe, expect, it } from 'vitest';
import { sceneBounds } from './thumbnail-bounds';
describe('scene thumbnail camera', () => {
  it('uses the mockup camera for an empty scene', () => { expect(sceneBounds([])).toEqual([0, 0, 1000, 625]); });
  it('contains every step, adds padding and keeps 16:10 for wide or tall scenes', () => {
    for (const bounds of [[[0, 0, 100, 100], [-400, -50, 1200, 100]], [[0, -1000, 10, 1000]]] as const) {
      const camera = sceneBounds(bounds);
      expect((camera[2] - camera[0]) / (camera[3] - camera[1])).toBeCloseTo(1.6);
      for (const box of bounds) { expect(camera[0]).toBeLessThanOrEqual(box[0] - 32); expect(camera[1]).toBeLessThanOrEqual(box[1] - 32); expect(camera[2]).toBeGreaterThanOrEqual(box[2] + 32); expect(camera[3]).toBeGreaterThanOrEqual(box[3] + 32); }
    }
  });
});
