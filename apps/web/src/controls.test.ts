import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Buttons, fields, menus and sizes follow T3 Code's: see docs/design/direction.md, “Controls: measured from T3 Code”.
const css = (name: string) => readFile(join(import.meta.dirname, 'styles', name), 'utf8');
const rule = (sheet: string, selector: string) => {
  const start = sheet.indexOf(`\n${selector} {`);
  expect(start, `${selector} is styled`).toBeGreaterThan(-1);
  return sheet.slice(start, sheet.indexOf('}', start));
};

describe('controls measured from T3 Code', () => {
  it('has its sizes, radii, text and icons as tokens', async () => {
    const tokens = await css('tokens.css');
    for (const token of [
      '--control-h: 32px', '--control-h-sm: 28px', '--control-h-xs: 24px', '--control-h-lg: 36px',
      '--radius-sm: 4px', '--radius-md: 8px', '--radius-lg: 16px',
      '--text-14: 14px', '--icon: 16px', '--icon-stroke: 1.75', '--disabled-opacity: 0.64',
    ]) expect(tokens).toContain(token);
  });

  it('uses them in the shared component styles, with no raw size left behind', async () => {
    const app = await css('app.css');
    expect(rule(app, 'body')).toContain('var(--text-14)');
    expect(rule(app, 'svg.i')).toContain('stroke-width: var(--icon-stroke)');
    expect(rule(app, '.btn')).toMatch(/height: var\(--control-h\);.*border-radius: var\(--radius-md\);.*font-weight: var\(--weight-medium\)/);
    expect(rule(app, '.nav-row')).toContain('height: var(--control-h)');
    expect(rule(app, '.menu')).toContain('padding: var(--space-1)');
    expect(rule(app, '.menu button')).toMatch(/height: var\(--control-h-sm\);.*border-radius: var\(--radius-sm\)/);
    expect(rule(app, '.popover')).toContain('border-radius: var(--radius-md)');
    expect(rule(app, '.dialog')).toContain('border-radius: var(--radius-lg)');
    expect(rule(await css('agent.css'), '.composer__control')).toContain('height: var(--control-h-xs)');
    for (const sheet of ['app.css', 'agent.css', 'present.css', 'storyboard.css', 'carousel.css', 'step-frame.css']) {
      expect(await css(sheet), `${sheet} has no 13px text left`).not.toContain('--text-13');
    }
  });

  it('keeps the focus ring and shrinks a press, except on a button that opens a menu', async () => {
    const app = await css('app.css');
    expect(app).toContain(':focus-visible { outline: none; box-shadow: var(--focus-ring) !important; }');
    expect(app).toContain('.btn:active:not(:disabled):not([aria-haspopup]), .icon-btn:active:not(:disabled):not([aria-haspopup]) { scale: 0.97; }');
  });
});

describe('folded activity bar', () => {
  it('centres the macOS window buttons on a black strip when folded', async () => {
    const app = await css('app.css');
    const tokens = await css('tokens.css');
    const mac = ":root[data-window-controls='mac']";
    const macFolded = `${mac} .app--folded`;
    expect(rule(tokens, mac)).toContain('--bar-top: 42px');
    expect(rule(app, '.app')).toContain('background: var(--bar)');
    expect(rule(app, '.app--folded')).toContain('--bar-w: 44px');
    expect(rule(app, macFolded)).toContain('grid-template-rows: var(--bar-top) minmax(0, 1fr)');
    expect(rule(app, `${macFolded}::before`)).toContain('grid-column: 2; grid-row: 1; -webkit-app-region: drag');
    expect(rule(app, `${macFolded} .activity-bar`)).toContain('grid-row: 1 / -1');
    expect(rule(app, `${macFolded} .shell`)).toContain('grid-row: 2');
  });
});
