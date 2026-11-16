import { readFile } from 'node:fs/promises';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { brandFaviconHref } from '@paso/shared';
import config from '../vite.config';

describe('the browser tab icon', () => {
  it('is injected from the brand mark, with no copy in index.html', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/rel="icon"/);
    const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production' }) : config;
    const plugin = (resolved.plugins as Plugin[]).find((item) => item?.name === 'paso-favicon')!;
    const transform = plugin.transformIndexHtml as () => HtmlTagDescriptor[];
    expect(transform()).toEqual([{ tag: 'link', attrs: { rel: 'icon', type: 'image/svg+xml', href: brandFaviconHref() }, injectTo: 'head' }]);
  });
});
