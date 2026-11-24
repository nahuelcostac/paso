import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { brandFaviconHref } from '@paso/shared';

const require = createRequire(import.meta.url);
const webPort = Number(process.env.PASO_WEB_PORT ?? 5173);
const servicePort = Number(process.env.PASO_PORT ?? 3001);
const desktopDev = process.env.PASO_DESKTOP_DEV === '1';
const fonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
let patchedFontFallback = false;

export default defineConfig(({ command }) => ({
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Excalidraw's worker and the app share this generated helper module.
          // Keep it out of the browser entry, which cannot execute in a worker.
          if (id.includes('/@excalidraw/excalidraw/dist/prod/chunk-SRAX5OIU.js')) return 'excalidraw-runtime-helpers';
        },
      },
    },
  },
  plugins: [react(), {
    name: 'paso-no-external-excalidraw-fonts',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js')) return;
      // Chromium checks every FontFace source against CSP, including an unused fallback.
      // The bundled files are the only sources Paso should use, including during SVG export.
      const fallback = 'return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r';
      if (!code.includes(fallback)) throw new Error('Excalidraw font fallback changed; review the offline font patch');
      patchedFontFallback = true;
      return code.replace(fallback, 'return r');
    },
    buildStart() { patchedFontFallback = false; },
    buildEnd(error) {
      if (!error && !patchedFontFallback) throw new Error('Excalidraw font fallback patch was not applied');
    },
  }, {
    name: 'paso-check-subsetting-worker',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
      const worker = chunks.find((chunk) => chunk.facadeModuleId?.endsWith('/subset-worker.chunk.js'));
      if (!worker) throw new Error('Excalidraw subsetting worker is missing from the build');
      const visited = new Set<string>();
      const check = (fileName: string) => {
        if (visited.has(fileName)) return;
        visited.add(fileName);
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== 'chunk') return;
        if (chunk.isEntry) throw new Error(`Subsetting worker depends on app entry ${fileName}`);
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) check(dependency);
      };
      check(worker.fileName);
    },
  }, {
    name: 'paso-offline-excalidraw-fonts',
    async writeBundle(options) { await cp(fonts, resolve(options.dir ?? 'dist', 'excalidraw/fonts'), { recursive: true }); },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (request, response, next) => {
        const path = decodeURIComponent((request.url ?? '').split('?')[0]);
        if (!/^\/[A-Za-z]+\/[A-Za-z0-9_-]+\.woff2$/.test(path)) { next(); return; }
        void readFile(join(fonts, path)).then((bytes) => {
          response.setHeader('Content-Type', 'font/woff2'); response.end(bytes);
        }).catch(() => { response.statusCode = 404; response.end(); });
      });
    },
  }, {
    // The tab icon is the sidebar mark, drawn from brandMark in @paso/shared.
    name: 'paso-favicon',
    transformIndexHtml() {
      return [{ tag: 'link', attrs: { rel: 'icon', type: 'image/svg+xml', href: brandFaviconHref() }, injectTo: 'head' }];
    },
  }, {
    name: 'paso-dev-session',
    configureServer(server) {
      const origins = new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);
      server.middlewares.use((request, response, next) => {
        if (!new Set([`127.0.0.1:${webPort}`, `localhost:${webPort}`]).has(request.headers.host ?? '') ||
          (request.headers.origin !== undefined && !origins.has(request.headers.origin))) {
          response.statusCode = 403; response.end('Forbidden'); return;
        }
        response.setHeader('Cache-Control', 'no-store');
        next();
      });
    },
    transformIndexHtml() {
      const token = process.env.PASO_SESSION_TOKEN;
      if (command !== 'serve' || desktopDev) return [];
      if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Start Paso with pnpm dev.');
      return [{ tag: 'meta', attrs: { name: 'paso-session-token', content: token }, injectTo: 'head' }];
    },
  }],
  server: {
    host: '127.0.0.1', port: webPort, strictPort: true, cors: false,
    // In the desktop app the page is not on Vite's origin, so its HMR client is told where the socket is.
    ...(desktopDev ? { hmr: { protocol: 'ws', host: '127.0.0.1', port: webPort, clientPort: webPort } } : {}),
    proxy: { '/api': { target: `http://127.0.0.1:${servicePort}`, changeOrigin: true, ws: true } },
  },
}));
