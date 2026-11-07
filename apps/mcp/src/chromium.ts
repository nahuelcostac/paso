import { spawn } from 'node:child_process';

type Reply = { id?: number; result?: Record<string, unknown>; error?: { message: string } };
export async function chromiumImage(executable: string, profile: string, url: string): Promise<string> {
  const child = spawn(executable, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-pipe',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let buffer = '';
  let exited = false;
  const fail = () => { for (const request of pending.values()) request.reject(new Error('Chromium closed its private render pipe.')); pending.clear(); };
  const closed = new Promise<void>((resolve) => { child.once('close', () => { exited = true; fail(); resolve(); }); });
  child.once('error', fail);
  const input = child.stdio[3] as NodeJS.WritableStream;
  const output = child.stdio[4] as NodeJS.ReadableStream;
  input.on('error', fail); output.on('error', fail);
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 32 * 1024 * 1024) { fail(); return; }
    let end: number;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(message) as Reply;
        if (!reply.id) continue;
        const request = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.error) request?.reject(new Error('Chromium rejected the render command.'));
        else request?.resolve(reply.result ?? {});
      } catch { fail(); }
    }
  });
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (exited) { reject(new Error('Chromium exited.')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const stop = () => {
    if (exited) return;
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(() => { fail(); stop(); }, 30_000);
  try {
    await call('Browser.getVersion');
    const target = await call('Target.createTarget', { url: 'about:blank' });
    const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    await call('Page.navigate', { url }, sessionId);
    const result = await call('Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => {
        const check = () => {
          const image = document.getElementById('paso-image');
          if (image) resolve(image.textContent);
          else if (document.body?.textContent === 'Paso image unavailable.') reject(new Error('Render failed.'));
          else setTimeout(check, 50);
        }; check();
      })`, awaitPromise: true, returnByValue: true, timeout: 25_000,
    }, sessionId);
    const remote = result.result as { value?: unknown } | undefined;
    if (result.exceptionDetails || typeof remote?.value !== 'string') throw new Error('Chromium returned no image.');
    return remote.value;
  } finally {
    clearTimeout(timer);
    if (!exited) {
      void call('Browser.close').catch(() => {});
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => { deadline = setTimeout(resolve, 1500); })]);
      clearTimeout(deadline); stop();
      await closed;
    }
  }
}
