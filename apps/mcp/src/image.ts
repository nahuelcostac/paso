import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Step } from '@paso/shared';
import type { BoardApi } from './api.js';
import { chromiumImage } from './chromium.js';

export async function renderStep(api: BoardApi, projectId: string, step: Step): Promise<string> {
  if (!api.config.browserExecutable) throw new Error('IMAGE_UNAVAILABLE. No browser is configured. The host can set PASO_MCP_BROWSER_EXECUTABLE to an installed Chromium executable and restart MCP. No download is automatic. Use read_step for positions, labels, connections and potential overlaps, or open this step in Paso for a visual check.');
  const root = fileURLToPath(new URL('./renderer/', import.meta.url));
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  const types: Record<string, string> = { js: 'text/javascript', html: 'text/html', css: 'text/css', woff2: 'font/woff2' };
  const files: Record<string, unknown> = {};
  const used = new Set(step.elements.filter((element) => !element.isDeleted && element.fileId).map((element) => element.fileId!));
  let totalBytes = 0;
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'");
    if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || !request.url?.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const path = request.url.slice(prefix.length) || 'index.html';
    if (path === 'snapshot') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ step, files })); return; }
    if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+|fonts\/[A-Za-z]+\/[A-Za-z0-9_-]+\.woff2)$/.test(path)) { response.writeHead(404).end(); return; }
    void readFile(join(root, path)).then((bytes) => {
      response.writeHead(200, { 'Content-Type': types[path.split('.').at(-1)!] ?? 'application/octet-stream' }); response.end(bytes);
    }).catch(() => { response.writeHead(404).end(); });
  });
  let profile: string | undefined;
  try {
    for (const fileId of used) {
      const file = step.files[fileId];
      if (!file || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(file.mimeType)) throw new Error('Unsupported image asset.');
      const bytes = await api.asset(projectId, file.path);
      totalBytes += bytes.length;
      if (totalBytes > 70 * 1024 * 1024) throw new Error('Render assets exceed the total size limit.');
      files[fileId] = { ...file, id: fileId, dataURL: `data:${file.mimeType};base64,${bytes}` };
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Renderer could not bind loopback.');
    port = address.port;
    profile = await mkdtemp(join(tmpdir(), 'paso-mcp-render-'));
    const image = await chromiumImage(api.config.browserExecutable, profile, `http://127.0.0.1:${port}${prefix}`);
    if (!image || !Buffer.from(image, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Renderer returned no PNG.');
    return image;
  } catch {
    throw new Error('IMAGE_UNAVAILABLE. The local Excalidraw renderer failed or timed out. Check the host browser executable and compiled renderer assets. No write was attempted. Use read_step for the layout, or open the step in Paso.');
  } finally {
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}
