import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'paso-dev-session',
    configureServer(server) {
      const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
      server.middlewares.use((request, response, next) => {
        if (!new Set(['127.0.0.1:5173', 'localhost:5173']).has(request.headers.host ?? '') ||
          (request.headers.origin !== undefined && !origins.has(request.headers.origin))) {
          response.statusCode = 403; response.end('Forbidden'); return;
        }
        response.setHeader('Cache-Control', 'no-store');
        next();
      });
    },
    transformIndexHtml() {
      const token = process.env.PASO_SESSION_TOKEN;
      if (command !== 'serve') return [];
      if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Start Paso with pnpm dev.');
      return [{ tag: 'meta', attrs: { name: 'paso-session-token', content: token }, injectTo: 'head' }];
    },
  }],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true, ws: true } },
  },
}));
