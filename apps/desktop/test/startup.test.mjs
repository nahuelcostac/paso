import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDERED_CHECK, STARTUP_TIMEOUT_MS, STOPPED, consoleEntry, openLog, serviceErrorMessage, startupErrorChoice, startupErrorDialog, watchPage } from '../lib/startup.mjs';

describe('the log', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'paso-log-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('appends timestamped lines, with errors on one line', async () => {
    const log = openLog(join(dir, 'logs'), { now: () => new Date('2026-11-27T10:00:00Z') });
    expect(log.file).toBe(join(dir, 'logs', 'main.log'));
    log.write('Starting Paso', { version: '0.1.0' });
    log.write('Paso failed to start', new Error('EACCES: permission denied'));
    const lines = (await readFile(log.file, 'utf8')).trimEnd().split('\n');
    expect(lines[0]).toBe('2026-11-27T10:00:00.000Z Starting Paso {"version":"0.1.0"}');
    expect(lines[1]).toMatch(/^2026-11-27T10:00:00.000Z Paso failed to start Error: EACCES: permission denied \| at /);
    expect(lines).toHaveLength(2);
  });

  it('keeps the previous log aside once it is too big, and at most two files', async () => {
    await writeFile(join(dir, 'main.log'), 'x'.repeat(200));
    await writeFile(join(dir, 'main.old.log'), 'older');
    openLog(dir, { maxBytes: 100 }).write('fresh');
    expect(await readFile(join(dir, 'main.old.log'), 'utf8')).toBe('x'.repeat(200));
    expect(await readFile(join(dir, 'main.log'), 'utf8')).toMatch(/ fresh\n$/);
    openLog(dir, { maxBytes: 100 }).write('again');
    expect((await readFile(join(dir, 'main.log'), 'utf8')).split('\n')).toHaveLength(3);
  });

  it('never throws when the log cannot be written', () => {
    const blocker = join(dir, 'file');
    return writeFile(blocker, '').then(() => {
      const log = openLog(join(blocker, 'logs'));
      expect(() => log.write('lost')).not.toThrow();
      expect(existsSync(log.file)).toBe(false);
    });
  });
});

describe('the watch on the page while it opens', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = (isRendered) => {
    const contents = new EventEmitter();
    const log = { write: vi.fn() };
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const stop = watchPage(contents, { isRendered, log, onReady, onFailure, now: Date.now });
    const lines = () => log.write.mock.calls.map(([message]) => message);
    return { contents, log, lines, onReady, onFailure, stop };
  };

  it('reports the page ready once the app has rendered, and stops listening', async () => {
    let rendered = false;
    const { contents, lines, onReady, onFailure } = setup(async () => rendered);
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onReady).not.toHaveBeenCalled();
    rendered = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(onReady).toHaveBeenCalledOnce();
    expect(lines()).toContain('Page loaded');
    expect(lines().at(-1)).toMatch(/^Page ready after \d+ ms$/);
    expect(contents.eventNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('says so when nothing appears in time, as when the page is frozen and never answers', async () => {
    const { contents, onFailure, onReady, lines } = setup(() => new Promise(() => {}));
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('Nothing appeared within 20 seconds.');
    expect(lines()).toContain('Startup failed: Nothing appeared within 20 seconds.');
    expect(onReady).not.toHaveBeenCalled();
    expect(contents.eventNames()).toEqual([]);
  });

  it('times out even when the page never finishes loading', async () => {
    const { onFailure } = setup(async () => true);
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('fails at once when the main frame does not load, but not for a replaced load or a subframe', async () => {
    const { contents, onFailure, log } = setup(async () => false);
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'paso://app/', true);
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'paso://app/frame', false);
    expect(onFailure).not.toHaveBeenCalled();
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'paso://app/', true);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("The page didn't load (ERR_FILE_NOT_FOUND -6).");
    expect(log.write).toHaveBeenCalledWith("Startup failed: The page didn't load (ERR_FILE_NOT_FOUND -6).", { url: 'paso://app/' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('fails at once when the page comes back with an error status', () => {
    const { contents, onFailure } = setup(async () => false);
    contents.emit('did-navigate', {}, 'paso://app/', 200);
    expect(onFailure).not.toHaveBeenCalled();
    contents.emit('did-navigate', {}, 'paso://app/', 404);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("The page didn't load (status 404).");
  });

  it('fails when the page process stops or the preload fails', () => {
    const crashed = setup(async () => false);
    crashed.contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 });
    expect(crashed.onFailure).toHaveBeenCalledExactlyOnceWith("The page's process stopped (oom).");
    const preload = setup(async () => false);
    preload.contents.emit('preload-error', {}, 'C:\\Paso\\preload.cjs', new Error('boom'));
    expect(preload.onFailure).toHaveBeenCalledExactlyOnceWith("The window's connection to Paso failed.");
  });

  it('keeps checking when the check itself fails, and logs why', async () => {
    let calls = 0;
    const { contents, onReady, lines } = setup(async () => { calls += 1; if (calls === 1) throw new Error('Script failed to execute'); return true; });
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(250);
    expect(lines()).toContain('Could not check the page');
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('can be stopped before anything happens', async () => {
    const { stop, onFailure, contents } = setup(async () => false);
    stop();
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'paso://app/', true);
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('what the person sees', () => {
  it('names the problem and where the log is, and offers to try again, open the log folder or quit', () => {
    const options = startupErrorDialog('Nothing appeared within 20 seconds.', 'C:\\Users\\me\\AppData\\Roaming\\paso-desktop\\logs\\main.log');
    expect(options).toMatchObject({ type: 'error', message: "Paso didn't finish opening.", buttons: ['Try Again', 'Open Log Folder', 'Quit'], defaultId: 0, cancelId: 2 });
    expect(options.detail).toBe('Nothing appeared within 20 seconds.\n\nThe details are in the log:\nC:\\Users\\me\\AppData\\Roaming\\paso-desktop\\logs\\main.log');
    expect([0, 1, 2, -1].map(startupErrorChoice)).toEqual(['retry', 'open-log', 'quit', 'quit']);
    expect(startupErrorDialog("The page's process stopped (crashed).", 'main.log', STOPPED).message).toBe("Paso's window stopped working.");
  });

  it('explains a service that could not start', () => {
    expect(serviceErrorMessage(new Error('EACCES: permission denied, mkdir'), 'main.log')).toEqual({
      title: "Paso couldn't start", content: 'EACCES: permission denied, mkdir\n\nThe details are in the log:\nmain.log',
    });
  });

  it('keeps only warnings and errors from the page console', () => {
    expect(consoleEntry({ level: 'info', message: 'hello' })).toBeNull();
    expect(consoleEntry({ level: 1, message: 'hello' })).toBeNull();
    expect(consoleEntry({ level: 'error', message: 'Uncaught TypeError', sourceId: 'paso://app/assets/index.js', lineNumber: 12 }))
      .toEqual({ level: 'error', message: 'Uncaught TypeError', source: 'paso://app/assets/index.js:12' });
    expect(consoleEntry({ level: 2, message: 'careful' })).toEqual({ level: 'warning', message: 'careful', source: undefined });
  });

  it('checks for the app in the page the web build serves', async () => {
    const html = await readFile(join(import.meta.dirname, '../../web/index.html'), 'utf8');
    expect(html).toContain('<div id="root"></div>');
    expect(RENDERED_CHECK).toContain("getElementById('root')");
  });
});
