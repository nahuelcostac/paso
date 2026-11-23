/**
 * The desktop app's page lives at one fixed origin, `paso://app`, in the packaged app and in `pnpm dev:desktop` alike.
 * Its service listens on a port chosen at each launch, so a page served from that port had a new origin every time,
 * and everything it kept per origin (localStorage, IndexedDB with its unsaved-step recovery) was lost on relaunch.
 * The storage itself is in the Electron profile, so an instance with its own PASO_DATA_DIR, which has its own profile,
 * still never shares it with the person's Paso.
 *
 * This module does not import Electron, so it can be tested in Node.
 */

export const APP_SCHEME = 'paso';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

/**
 * Privileges for `protocol.registerSchemesAsPrivileged`, before the app is ready. `standard` gives the scheme real
 * origins (and so localStorage and IndexedDB); `secure` makes the page a secure context, as 127.0.0.1 was; fetch,
 * CORS and streaming let modules, workers, fonts and the API go through it. No service workers, no CSP bypass.
 */
export const APP_SCHEME_PRIVILEGES = { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } };

/**
 * Whether a URL is the app's own page. Node's URL gives every non-web scheme the origin "null", so the scheme and host
 * are compared instead of `origin`.
 */
export function isAppUrl(raw) {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST && !url.username && !url.password;
  } catch { return false; }
}

/** The loopback `host:port` of a service URL such as `http://127.0.0.1:50124`. */
export const hostOf = (serviceUrl) => new URL(serviceUrl).host;

/**
 * The renderer may reach only the app's own page and the loopback services named here (the Paso service, and Vite with
 * its HMR socket in development), by HTTP or WebSocket. Every other request is cancelled.
 * @param {string} raw
 * @param {string[]} hosts `host:port` of each allowed service.
 */
export function isRequestAllowed(raw, hosts) {
  if (isAppUrl(raw)) return true;
  try {
    const url = new URL(raw);
    if (['data:', 'blob:', 'devtools:'].includes(url.protocol)) return true;
    return (url.protocol === 'http:' || url.protocol === 'ws:') && hosts.includes(url.host);
  } catch { return false; }
}

/**
 * Where a request to the app's page goes: `/api` to the Paso service, which checks its token and origin as before;
 * anything else to the page's files, or to Vite in development.
 * @returns {{ kind: 'api' | 'page'; path: string } | null} The path with its query, or null for another origin.
 */
export function routeAppRequest(raw) {
  if (!isAppUrl(raw)) return null;
  const url = new URL(raw);
  const path = `${url.pathname}${url.search}`;
  return { kind: url.pathname === '/api' || url.pathname.startsWith('/api/') ? 'api' : 'page', path };
}

/** The page's Content Security Policy in the packaged app: its own origin, and the service's event socket. */
export const appCsp = (servicePort) => `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${servicePort}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'`;

/** The event stream's address, which the page reaches directly: a protocol handler cannot carry a WebSocket. */
export const eventsUrl = (serviceUrl) => `${serviceUrl.replace(/^http/, 'ws')}/api/events`;
