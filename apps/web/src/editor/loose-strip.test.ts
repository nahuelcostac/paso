import { describe, expect, it } from 'vitest';
import { stripShown } from './loose-strip';

describe('the step strip of a loose diagram', () => {
  it('is hidden with one step and shown with several, until the person chooses', () => {
    expect(stripShown(1, undefined)).toBe(false);
    expect(stripShown(2, undefined)).toBe(true);
    expect(stripShown(1, 'shown')).toBe(true);
    expect(stripShown(4, 'hidden')).toBe(false);
  });
  it('always shows with no steps, where “Add step” is', () => {
    expect(stripShown(0, 'hidden')).toBe(true);
    expect(stripShown(0, undefined)).toBe(true);
  });
});
