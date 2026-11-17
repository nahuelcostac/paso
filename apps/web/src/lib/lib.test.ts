import { describe, expect, it } from 'vitest';
import { describeContents, explainProjectError, fold, formatSize, groupByRecency } from './format';
import { legacyRouteHash, parseRoute, routeHash } from './route';
import { ICONS } from './icon-catalog';
import { iconFor, searchIcons } from './icons';
import { Folder } from 'lucide-react';

describe('formatSize', () => {
  it('writes the size as the brief shows it, with English plurals', () => {
    expect(formatSize(4, 17)).toBe('4 scenes · 17 steps');
    expect(formatSize(1, 1)).toBe('1 scene · 1 step');
    expect(formatSize(2, 0)).toBe('2 scenes · 0 steps');
    expect(formatSize(0, 0)).toBe('No scenes');
    expect(describeContents(3, 12)).toBe('3 scenes and 12 steps');
  });
});

describe('routes', () => {
  it('keeps the project and the view in the hash', () => {
    expect(parseRoute('#/abc-123/canvas')).toEqual({ projectId: 'abc-123', view: 'canvas' });
    expect(routeHash({ projectId: 'abc-123', view: 'storyboard' })).toBe('#/abc-123/storyboard');
    expect(parseRoute(routeHash({ projectId: 'p_1', view: 'canvas' }))).toEqual({ projectId: 'p_1', view: 'canvas' });
  });
  it('falls back to the board and to no project for anything else', () => {
    expect(parseRoute('')).toEqual({ projectId: null, view: 'canvas' });
    expect(parseRoute('#/')).toEqual({ projectId: null, view: 'canvas' });
    expect(parseRoute('#/p/present')).toEqual({ projectId: 'p', view: 'canvas' });
    expect(parseRoute('#/p/storyboard')).toEqual({ projectId: 'p', view: 'storyboard' });
    expect(parseRoute('#/../etc/canvas').projectId).toBeNull();
    expect(parseRoute('#/a b/canvas').projectId).toBeNull();
  });
  it('still opens an address from before, which named the Canvas “lienzo”, and gives it the new name', () => {
    expect(parseRoute('#/p/lienzo/s/t')).toEqual({ projectId: 'p', view: 'canvas', sceneId: 's', stepId: 't' });
    expect(legacyRouteHash('#/p/lienzo/s/t')).toBe('#/p/canvas/s/t');
    expect(legacyRouteHash('#/p/lienzo')).toBe('#/p/canvas');
    expect(legacyRouteHash('#/p/canvas/s/t')).toBeUndefined();
    expect(legacyRouteHash('#/p/storyboard/s')).toBeUndefined();
    expect(legacyRouteHash('#/')).toBeUndefined();
  });
});

it('round-trips scene and step and rejects unsafe IDs', () => {
  const route = { projectId: 'p', view: 'canvas' as const, sceneId: 's', stepId: 't' };
  expect(routeHash(route)).toBe('#/p/canvas/s/t');
  expect(parseRoute(routeHash(route))).toEqual(route);
  expect(parseRoute('#/p/canvas/../bad%20step')).toEqual({ projectId: 'p', view: 'canvas' });
});

describe('icons', () => {
  it('lists each Lucide name once, in the shape the format allows', () => {
    const names = ICONS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(names[0]).toBe('folder');
  });
  it('shows a folder for no icon and for a name this build does not list', () => {
    expect(iconFor(undefined)).toBe(Folder);
    expect(iconFor('an-icon-from-the-future')).toBe(Folder);
    expect(iconFor('leaf')).not.toBe(Folder);
  });
  it('searches the name, the keywords and the Lucide name, ignoring accents and case', () => {
    expect(searchIcons('MUSIC').map((entry) => entry.name)).toContain('music');
    expect(searchIcons('sóng').map((entry) => entry.name)).toContain('music');
    expect(searchIcons('scatter').map((entry) => entry.name)).toContain('chart-scatter');
    expect(searchIcons('regression').map((entry) => entry.name)).toContain('chart-scatter');
    expect(searchIcons('  ')).toHaveLength(ICONS.length);
    expect(searchIcons('zzzzzz')).toEqual([]);
    expect(fold('Diseño ÁÉÍ')).toBe('diseno aei');
  });
});

describe('explainProjectError', () => {
  it('tells a newer project from a damaged one', () => {
    const newer = explainProjectError('Schema version 2 is newer than supported version 1. Upgrade Paso before opening this file.');
    expect(newer.short).toMatch(/newer version/);
    expect(newer.long).toMatch(/Update Paso/);
    expect(explainProjectError('[{"code":"invalid_type"}]').short).toMatch(/damaged/);
  });
});

describe('groupByRecency', () => {
  it('groups by today, earlier this month and before, on the local calendar, and leaves out empty groups', () => {
    const now = new Date(2026, 10, 10, 9, 30);
    const at = (...parts: [number, number, number, number?]) => new Date(...(parts as [number, number, number, number])).toISOString();
    const items = [
      { name: 'esta mañana', at: at(2026, 10, 10, 0) },
      { name: 'ayer', at: at(2026, 10, 9, 23) },
      { name: 'día 1', at: at(2026, 10, 1, 0) },
      { name: 'octubre', at: at(2026, 9, 31, 23) },
      { name: 'otro reloj', at: at(2026, 10, 12, 0) },
    ];
    expect(groupByRecency(items, (item) => item.at, now).map((group) => [group.label, group.items.map((item) => item.name)])).toEqual([
      ['Today', ['esta mañana', 'otro reloj']], ['This month', ['ayer', 'día 1']], ['Earlier', ['octubre']],
    ]);
    expect(groupByRecency([items[3]], (item) => item.at, now).map((group) => group.label)).toEqual(['Earlier']);
  });
});
