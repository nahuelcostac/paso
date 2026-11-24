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

describe('sidebar layout', () => {
  it('fits the macOS window buttons and centres the sidebar toggle beside the bar', async () => {
    const app = await css('app.css');
    const tokens = await css('tokens.css');
    const mac = ":root[data-window-controls='mac']";
    expect(rule(tokens, mac)).toContain('--bar-top: 42px');
    expect(rule(tokens, mac)).toContain('--window-controls-w: 80px');
    expect(rule(tokens, ':root')).toContain('--bar: var(--panel-bg)');
    expect(rule(app, '.app')).toContain('grid-template: minmax(0, 1fr) / var(--left) minmax(0, 1fr)');
    expect(rule(app, '.sidebar-toggle')).toContain('top: calc((var(--bar-top) - var(--control-h-sm)) / 2)');
    expect(rule(app, '.sidebar-toggle')).toContain('left: var(--sidebar-toggle-start)');
    expect(rule(app, '.app')).toContain('--window-header-bg: var(--page)');
    expect(rule(app, ".app[data-view='canvas']")).toContain('--window-header-bg: var(--paper)');
    // The sidebar's head is the panel's colour in the Diagram and the Studio alike, not the view's header colour.
    expect(app).not.toContain(`\n${mac} .sidebar {`);
    expect(rule(app, ":root .sidebar-toggle[aria-expanded='true']")).toContain('--surface: var(--panel-bg)');
  });

  it('gives Present and “Frame” one column, so they line up at one width in both views', async () => {
    const app = await css('app.css');
    expect(rule(app, '.canvas__corner')).toContain('--corner-w: 104px');
    expect(rule(app, '.canvas__corner')).toContain('grid-template-columns: max-content var(--corner-w)');
    expect(rule(app, '.canvas__corner > .btn--primary')).toContain('grid-column: 2');
    expect(rule(app, '.canvas__corner > .camera-control')).toContain('grid-column: 2');
    expect(rule(app, '.canvas__corner > .camera-control')).not.toContain('justify-self');
  });

  it('keeps the step strip\'s scrollbar slim, so its thumbnails stay under its top', async () => {
    const carousel = await css('carousel.css');
    // Over its bar the strip is 100px and its thumbnails 88px, anchored at its foot: a scrollbar over 9px pushes them up
    // under the canvas.
    expect(carousel).toContain('.carousel__frames::-webkit-scrollbar { height: 4px; }');
    expect(carousel).toContain('.carousel__frames { scrollbar-width: auto; scrollbar-color: auto; }');
  });

  it('keeps the macOS panel drag region to the right of the sidebar toggle', async () => {
    const app = await css('app.css');
    const mac = ":root[data-window-controls='mac']";
    expect(rule(app, '.sidebar')).not.toContain('-webkit-app-region: drag');
    expect(rule(app, `${mac} .panel-brand::before`)).toContain('width: var(--window-controls-w)');
    expect(rule(app, `${mac} .panel-brand .brand`)).toContain('-webkit-app-region: drag');
    expect(rule(app, '.panel-brand')).toContain('padding: 0 var(--space-3) var(--bar-top-gap) var(--sidebar-toggle-inset)');
  });

  it('uses the sidebar theme colour and places the workspace controls at the bottom', async () => {
    const app = await css('app.css');
    expect(rule(app, '.sidebar')).toContain('--surface: var(--panel-bg)');
    expect(rule(app, '.sidebar__tools')).toContain('margin-top: auto');
  });

  it('uses larger text for the Loose diagrams heading than for its entries', async () => {
    const app = await css('app.css');
    expect(rule(app, '.project-group__title--loose')).toContain('font-size: var(--text-14)');
    // As far above the first diagram as the diagrams sit apart: no h3 margin, 6px under its padding.
    expect(rule(app, '.project-group__title--loose')).toContain('margin: 0 0 6px');
    expect(rule(app, '.project--loose')).toContain('font-size: var(--text-12)');
  });
});
