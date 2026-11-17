import { describe, expect, it } from 'vitest';
import { stripKey, stripShown } from './loose-strip';

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
  it('is shown in a project until the person hides it, remembered per project', () => {
    expect(stripShown(1, undefined, false)).toBe(true);
    expect(stripShown(3, 'hidden', false)).toBe(false);
    expect(stripKey('p', 's', false)).toBe('project:p');
    expect(stripKey('_loose', 's', true)).toBe('s');
  });
});
