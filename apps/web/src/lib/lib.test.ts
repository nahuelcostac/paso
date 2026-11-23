import { describe, expect, it } from 'vitest';
import { describeContents, explainProjectError, fold, formatSize } from './format';
import { legacyRouteHash, parseRoute, routeHash } from './route';
import { ICONS } from './icon-catalog';
import { iconFor, searchIcons } from './icons';
import { Folder } from 'lucide-react';
import { matchChoices, shownFilter, showsUnder } from './project-filter';
import type { ProjectRow } from '../state/projects-store';

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

describe('the project filter', () => {
  const rows = [{ kind: 'error', id: 'rota', message: 'Unreadable' }, { kind: 'ok', id: 'tema', project: { id: 'tema', name: 'Tema' } }] as unknown as ProjectRow[];
  it('falls back to all projects once the list shows its project is gone', () => {
    expect(shownFilter(undefined, rows, 'ready')).toBeNull();
    expect(shownFilter('tema', rows, 'ready')).toBe('tema');
    expect(shownFilter('rota', rows, 'ready')).toBe('rota');
    expect(shownFilter('_loose', [], 'ready')).toBe('_loose');
    expect(shownFilter('otro', rows, 'ready')).toBeNull();
    // Still loading: the project may be on the way.
    expect(shownFilter('otro', [], 'loading')).toBe('otro');
  });
  it('shows a project or the loose diagrams under their own filter, and everything under none', () => {
    expect(showsUnder(null, 'tema')).toBe(true);
    expect(showsUnder('tema', 'tema')).toBe(true);
    expect(showsUnder('tema', '_loose')).toBe(false);
    expect(showsUnder('_loose', '_loose')).toBe(true);
  });
  it('matches every word, ignoring case and accents, and leaves out “All projects” while searching', () => {
    const choices = [{ value: null, label: 'All projects' }, { value: 'a', label: 'Álgebra lineal' }, { value: 'b', label: 'Biología' }, { value: '_loose', label: 'Loose diagrams' }];
    expect(matchChoices(choices, '  ')).toBe(choices);
    expect(matchChoices(choices, 'LINEAL alge').map((choice) => choice.value)).toEqual(['a']);
    expect(matchChoices(choices, 'all').map((choice) => choice.value)).toEqual([]);
    expect(matchChoices(choices, 'loose').map((choice) => choice.value)).toEqual(['_loose']);
  });
});
