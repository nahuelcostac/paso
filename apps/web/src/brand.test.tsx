// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { brandMark, brandMarkLayout } from '@paso/shared';
import { Brand } from './components/Brand';

afterEach(cleanup);

describe('the sidebar mark', () => {
  it('is drawn from brandMark in @paso/shared', () => {
    const { container } = render(<Brand />);
    const layout = brandMarkLayout();
    const svg = container.querySelector('svg.brand__mark')!;
    expect(svg.getAttribute('width')).toBe(String(layout.size));
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${layout.size} ${layout.size}`);
    const tile = svg.querySelector('rect')!;
    expect([tile.getAttribute('width'), tile.getAttribute('rx')]).toEqual([String(layout.tile.size), String(layout.tile.radius)]);
    const step = svg.querySelector('path')!;
    expect(step.getAttribute('d')).toBe(brandMark.step);
    expect(step.getAttribute('transform')).toBe(layout.step.transform);
    expect(step.getAttribute('stroke-width')).toBe(String(brandMark.strokeWidth));
    expect(step.getAttribute('stroke-linecap')).toBe(brandMark.strokeLinecap);
  });

  it('takes the light theme colours that the tab and desktop icons use', async () => {
    const tokens = await readFile(join(import.meta.dirname, 'styles/tokens.css'), 'utf8');
    expect(tokens).toContain(`--ink: light-dark(${brandMark.ink},`);
    expect(tokens).toContain(`--on-ink: light-dark(${brandMark.onInk},`);
    const app = await readFile(join(import.meta.dirname, 'styles/app.css'), 'utf8');
    expect(app).toMatch(/\.brand__tile \{ fill: var\(--ink\); \}/);
    expect(app).toMatch(/\.brand__step \{ fill: none; stroke: var\(--on-ink\); \}/);
  });
});
