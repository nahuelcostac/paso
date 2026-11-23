import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, APP_SCHEME_PRIVILEGES, APP_URL, appCsp, eventsUrl, hostOf, isAppUrl, isRequestAllowed, routeAppRequest } from '../lib/app-origin.mjs';
import { forward, serveApp, staticPage } from '../lib/app-protocol.mjs';

describe('the app’s fixed origin', () => {
  it('is paso://app, a standard and secure scheme, so the page keeps its storage', () => {
    expect(APP_ORIGIN).toBe('paso://app');
    expect(APP_URL).toBe('paso://app/');
    expect(APP_SCHEME_PRIVILEGES).toEqual({ scheme: 'paso', privileges: expect.objectContaining({ standard: true, secure: true, supportFetchAPI: true }) });
    expect(APP_SCHEME_PRIVILEGES.privileges).not.toHaveProperty('bypassCSP');
    expect(APP_SCHEME_PRIVILEGES.privileges).not.toHaveProperty('allowServiceWorkers');
  });

  it('recognises only its own page', () => {
    for (const url of ['paso://app/', 'paso://app/index.html?x=1#/p/canvas']) expect(isAppUrl(url)).toBe(true);
    for (const url of ['paso://other/', 'paso://user:pw@app/', 'http://app/', 'http://127.0.0.1:50000/', 'file:///index.html', 'not a url', undefined]) expect(isAppUrl(url)).toBe(false);
  });

  it('lets the renderer reach its page and the named loopback services, and nothing else', () => {
    const hosts = [hostOf('http://127.0.0.1:50124'), '127.0.0.1:50123'];
    for (const url of ['paso://app/src/main.tsx', 'ws://127.0.0.1:50124/api/events', 'http://127.0.0.1:50123/@vite/client', 'ws://127.0.0.1:50123/?token=x', 'blob:paso://app/id', 'data:text/plain,x']) {
      expect(isRequestAllowed(url, hosts)).toBe(true);
    }
    for (const url of ['https://example.com/', 'http://127.0.0.1:3001/', 'ws://localhost:50124/', 'paso://evil/', 'file:///etc/passwd', 'wss://127.0.0.1:50124/', 'invalid']) {
      expect(isRequestAllowed(url, hosts)).toBe(false);
    }
  });

  it('sends /api to the service and the rest to the page, keeping the query', () => {
    expect(routeAppRequest('paso://app/api/projects?x=1')).toEqual({ kind: 'api', path: '/api/projects?x=1' });
    expect(routeAppRequest('paso://app/api')).toEqual({ kind: 'api', path: '/api' });
    expect(routeAppRequest('paso://app/apiary.js')).toEqual({ kind: 'page', path: '/apiary.js' });
    expect(routeAppRequest('paso://app/')).toEqual({ kind: 'page', path: '/' });
    expect(routeAppRequest('paso://other/api/projects')).toBeNull();
  });

  it('keeps the CSP to its own origin and the service’s socket, and names the socket', () => {
    expect(appCsp(50124)).toContain("default-src 'self'");
    expect(appCsp(50124)).toContain("connect-src 'self' ws://127.0.0.1:50124;");
    expect(eventsUrl('http://127.0.0.1:50124')).toBe('ws://127.0.0.1:50124/api/events');
  });
});

describe('the paso:// protocol handler', () => {
  let handler;
  const net = { fetch: vi.fn(async () => new Response('from the service', { status: 200 })) };
  const page = vi.fn(async (_request, path) => new Response(`page ${path}`));
  beforeAll(() => {
    serveApp({ session: { protocol: { handle: (scheme, fn) => { expect(scheme).toBe('paso'); handler = fn; } } }, net, serviceUrl: 'http://127.0.0.1:50124', page });
  });

  it('forwards the API with its token, without the page’s Host or Origin', async () => {
    const response = await handler(new Request('paso://app/api/projects?x=1', { method: 'POST', headers: { Authorization: 'Bearer t', Origin: 'paso://app', 'Content-Type': 'application/json' }, body: '{"a":1}' }));
    expect(await response.text()).toBe('from the service');
    const [target, init] = net.fetch.mock.calls.at(-1);
    expect(target).toBe('http://127.0.0.1:50124/api/projects?x=1');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', bypassCustomProtocolHandlers: true });
    expect(new TextDecoder().decode(init.body)).toBe('{"a":1}');
    expect(init.headers.get('authorization')).toBe('Bearer t');
    expect(init.headers.has('origin')).toBe(false);
    expect(init.headers.has('host')).toBe(false);
  });

  it('serves the page for everything else', async () => {
    expect(await (await handler(new Request('paso://app/assets/x.js'))).text()).toBe('page /assets/x.js');
  });

  it('refuses other hosts and requests sent by other origins', async () => {
    net.fetch.mockClear();
    expect((await handler(new Request('paso://evil/api/projects'))).status).toBe(403);
    expect((await handler(new Request('paso://app/api/projects', { headers: { Origin: 'https://example.com' } }))).status).toBe(403);
    expect((await handler(new Request('paso://app/api/projects', { headers: { Origin: 'null' } }))).status).toBe(403);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('answers 502 when the server cannot be reached, as while the app quits', async () => {
    net.fetch.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
    expect((await handler(new Request('paso://app/api/health'))).status).toBe(502);
  });

  it('sends GET without a body', async () => {
    await forward(net, new Request('paso://app/api/health'), 'http://127.0.0.1:1/api/health');
    expect(net.fetch.mock.calls.at(-1)[1].body).toBeUndefined();
  });
});

describe('the packaged page’s files', () => {
  let root;
  let serve;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paso-static-'));
    await mkdir(join(root, 'web', 'assets'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<h1>Paso</h1>');
    await writeFile(join(root, 'web', 'assets', 'app.js'), 'export {}');
    await writeFile(join(root, 'secret.txt'), 'outside');
    serve = staticPage({ webRoot: join(root, 'web'), csp: appCsp(50124) });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('serves index.html at the root and files with their type, nosniff and the CSP', async () => {
    const index = await serve(new Request('paso://app/'), '/');
    expect(await index.text()).toBe('<h1>Paso</h1>');
    expect(index.headers.get('content-type')).toBe('text/html');
    const script = await serve(new Request('paso://app/assets/app.js?v=1'), '/assets/app.js?v=1');
    expect(script.headers.get('content-type')).toBe('text/javascript');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    expect(script.headers.get('content-security-policy')).toBe(appCsp(50124));
  });

  it('never reads outside its folder, and only answers GET', async () => {
    expect((await serve(new Request('paso://app/x'), '/..%2Fsecret.txt')).status).toBe(403);
    expect((await serve(new Request('paso://app/x'), '/%E0%A4%A')).status).toBe(400);
    expect((await serve(new Request('paso://app/missing.js'), '/missing.js')).status).toBe(404);
    expect((await serve(new Request('paso://app/', { method: 'POST', body: 'x' }), '/')).status).toBe(405);
  });
});
