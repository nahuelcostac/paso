import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { APP_ORIGIN, APP_SCHEME, routeAppRequest } from './app-origin.mjs';

/**
 * Serves the page at `paso://app` in one Electron session: `/api` goes to the Paso service, which still checks its
 * session token; everything else comes from `page`. Requests for any other host, or sent by any other origin, are
 * refused here, since the forwarded request cannot carry its Origin (see `forward`).
 * @param {{ session: import('electron').Session; net: import('electron').Net; serviceUrl: string;
 *   page: (request: Request, path: string) => Promise<Response> }} options
 */
export function serveApp({ session, net, serviceUrl, page }) {
  session.protocol.handle(APP_SCHEME, async (request) => {
    const route = routeAppRequest(request.url);
    if (!route || !fromApp(request)) return new Response('Blocked', { status: 403 });
    try { return await (route.kind === 'api' ? forward(net, request, `${serviceUrl}${route.path}`) : page(request, route.path)); }
    // The server is gone or not up yet, as while the app quits: the page sees a failed request, not a crash.
    catch { return new Response('Unavailable', { status: 502 }); }
  });
}

/** A request with no Origin (a navigation, a same-origin GET) or with the app's own. */
export const fromApp = (request) => { const origin = request.headers.get('origin'); return origin === null || origin === APP_ORIGIN; };

/**
 * Sends a request on to a loopback server and answers with its response. Authorization and the rest go as they came;
 * Host becomes the target's, and Origin is dropped: Chromium's fetch refuses to send one it did not set, and
 * `serveApp` has already refused other origins.
 */
export async function forward(net, request, target) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('origin');
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return net.fetch(target, { method: request.method, headers, body, redirect: 'manual', bypassCustomProtocolHandlers: true });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

/**
 * The packaged page: files from the built web app, read only, never outside its folder, each with the CSP.
 * @param {{ webRoot: string; csp: string }} options
 */
export function staticPage({ webRoot, csp }) {
  const root = resolve(webRoot);
  return async (request, path) => {
    if (request.method !== 'GET') return new Response('Blocked', { status: 405 });
    const pathname = path.split('?')[0];
    let file;
    try { file = resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`); }
    catch { return new Response('Bad request', { status: 400 }); }
    if (!file.startsWith(root + sep)) return new Response('Blocked', { status: 403 });
    try {
      const bytes = await readFile(file);
      return new Response(bytes, { headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp } });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}
