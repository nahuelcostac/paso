import { defineConfig } from 'vite';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fontDirectory } from './src/font.js';

export default defineConfig({
  root: resolve(import.meta.dirname, 'renderer'),
  base: './',
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: { outDir: resolve(import.meta.dirname, 'dist/renderer'), target: 'es2022', emptyOutDir: true },
  plugins: [{ name: 'paso-mcp-local-fonts', async closeBundle() {
    await cp(fontDirectory, resolve(import.meta.dirname, 'dist/renderer/fonts'), { recursive: true });
  } }],
});
