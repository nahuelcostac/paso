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

describe('fixed activity bar', () => {
  it('fits the macOS window buttons and centres the sidebar toggle beside the bar', async () => {
    const app = await css('app.css');
    const tokens = await css('tokens.css');
    const mac = ":root[data-window-controls='mac']";
    expect(rule(tokens, mac)).toContain('--bar-top: 42px');
    expect(rule(tokens, mac)).toContain('--window-controls-w: 80px');
    expect(rule(tokens, ':root')).toContain('--bar-w: 44px');
    expect(rule(tokens, ':root')).toContain('--bar: var(--panel-bg)');
    expect(rule(tokens, mac)).not.toContain('--bar-w:');
    expect(rule(app, '.app')).toContain('grid-template: minmax(0, 1fr) / var(--bar-w) minmax(0, 1fr)');
    expect(app).not.toContain('--bar-w:');
    expect(rule(app, '.sidebar-toggle')).toContain('top: calc((var(--bar-top) - var(--control-h-sm)) / 2)');
    expect(rule(app, '.sidebar-toggle')).toContain('left: var(--sidebar-toggle-start)');
    expect(rule(app, '.app')).toContain('--window-header-bg: var(--page)');
    expect(rule(app, ".app[data-view='canvas']")).toContain('--window-header-bg: var(--paper)');
    expect(rule(app, `${mac} .activity-bar, ${mac} .panel-brand`)).toContain('linear-gradient(var(--window-header-bg) var(--bar-top), transparent var(--bar-top))');
  });

  it('keeps the macOS panel drag region to the right of the sidebar toggle', async () => {
    const app = await css('app.css');
    const mac = ":root[data-window-controls='mac']";
    expect(rule(app, `${mac} .activity-bar, ${mac} .panel-brand`)).not.toContain('-webkit-app-region: drag');
    expect(rule(app, `${mac} .panel-brand .brand`)).toContain('-webkit-app-region: drag');
    expect(rule(app, '.panel-brand')).toContain('padding: 0 var(--space-3) var(--bar-top-gap) var(--sidebar-toggle-inset)');
  });

  it('uses theme colours and one outline around the activity buttons', async () => {
    const app = await css('app.css');
    expect(rule(app, '.projects, .agent')).not.toContain('color-scheme: dark');
    expect(rule(app, '.activity-bar__buttons')).toContain('border: 1px solid var(--bar-line)');
  });
});
