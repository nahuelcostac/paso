import { describe, expect, it } from 'vitest';
import { describeContents, explainProjectError, fold, formatSize } from './format';
import { parseRoute, routeHash } from './route';
import { ICONS } from './icon-catalog';
import { iconFor, searchIcons } from './icons';
import { Folder } from 'lucide-react';

describe('formatSize', () => {
  it('writes the size as the brief shows it, with Spanish plurals', () => {
    expect(formatSize(4, 17)).toBe('4 escenas · 17 pasos');
    expect(formatSize(1, 1)).toBe('1 escena · 1 paso');
    expect(formatSize(2, 0)).toBe('2 escenas · 0 pasos');
    expect(formatSize(0, 0)).toBe('Sin escenas');
    expect(describeContents(3, 12)).toBe('3 escenas y 12 pasos');
  });
});

describe('routes', () => {
  it('keeps the project and the view in the hash', () => {
    expect(parseRoute('#/abc-123/lienzo')).toEqual({ projectId: 'abc-123', view: 'lienzo' });
    expect(routeHash({ projectId: 'abc-123', view: 'storyboard' })).toBe('#/abc-123/storyboard');
    expect(parseRoute(routeHash({ projectId: 'p_1', view: 'lienzo' }))).toEqual({ projectId: 'p_1', view: 'lienzo' });
  });
  it('falls back to the Storyboard and to no project for anything else', () => {
    expect(parseRoute('')).toEqual({ projectId: null, view: 'storyboard' });
    expect(parseRoute('#/')).toEqual({ projectId: null, view: 'storyboard' });
    expect(parseRoute('#/p/presentar')).toEqual({ projectId: 'p', view: 'storyboard' });
    expect(parseRoute('#/../etc/lienzo').projectId).toBeNull();
    expect(parseRoute('#/a b/lienzo').projectId).toBeNull();
  });
});

it('round-trips scene and step and rejects unsafe IDs', () => {
  const route = { projectId: 'p', view: 'lienzo' as const, sceneId: 's', stepId: 't' };
  expect(routeHash(route)).toBe('#/p/lienzo/s/t');
  expect(parseRoute(routeHash(route))).toEqual(route);
  expect(parseRoute('#/p/lienzo/../bad%20step')).toEqual({ projectId: 'p', view: 'lienzo' });
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
  it('searches the Spanish name, the keywords and the Lucide name, ignoring accents and case', () => {
    expect(searchIcons('MUSICA').map((entry) => entry.name)).toContain('music');
    expect(searchIcons('música').map((entry) => entry.name)).toContain('music');
    expect(searchIcons('scatter').map((entry) => entry.name)).toContain('chart-scatter');
    expect(searchIcons('regresion').map((entry) => entry.name)).toContain('chart-scatter');
    expect(searchIcons('  ')).toHaveLength(ICONS.length);
    expect(searchIcons('zzzzzz')).toEqual([]);
    expect(fold('Diseño ÁÉÍ')).toBe('diseno aei');
  });
});

describe('explainProjectError', () => {
  it('tells a newer project from a damaged one', () => {
    const newer = explainProjectError('Schema version 2 is newer than supported version 1. Upgrade Paso before opening this file.');
    expect(newer.short).toMatch(/más nueva/);
    expect(newer.long).toMatch(/Actualiza Paso/);
    expect(explainProjectError('[{"code":"invalid_type"}]').short).toMatch(/dañados/);
  });
});
