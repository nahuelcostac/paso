import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const windows = process.platform === 'win32';
export const fakePath = (file: string) => windows ? file + '.cmd' : file;

/** Makes a test executable with an npm-style shim on Windows and a Node launcher on POSIX. */
export async function writeLauncher(file: string, script: string) {
  if (windows) {
    const dir = join(dirname(file), 'node_modules', basename(file, '.cmd'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.mjs'), script);
    const target = ['%dp0%', 'node_modules', basename(dir), 'main.mjs'].join('\\');
    await writeFile(file, `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${target}" %*\r\n`);
  } else {
    const scriptPath = file + '.mjs';
    await writeFile(scriptPath, script);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`, { mode: 0o755 });
  }
  return file;
}

export function writeFixture(file: string, fixture: string, env: Record<string, string>) {
  return writeLauncher(file, `Object.assign(process.env, ${JSON.stringify(env)});\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
}
