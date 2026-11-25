import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function executable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile() ? realpathSync(file) : null;
  } catch { return null; }
}

export function windowsPathDirectories(path: string) {
  return path.split(';').map((part) => part.trim().replace(/^"(.*)"$/, '$1')).filter(isAbsolute);
}

export function windowsEnv(name: string, source = process.env) {
  return source[name] ?? Object.entries(source).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function npmEntry(shim: string) {
  try {
    // npm's cmd-shim ends by forwarding %* to an entry under the adjacent node_modules.
    // Read the path only. Running batch code would reparse the harness's JSON and other arguments.
    const script = readFileSync(shim, 'utf8').trimEnd();
    const native = /(?:^|\r?\n)"%dp0%\\(node_modules\\[^"\r\n]+\.exe)" +%\*$/i.exec(script)?.[1];
    const node = /^ *SET "_prog=node(?:\.exe)?"\r?$/im.test(script) &&
      /(?:^|\r?\n)endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\(node_modules\\[^"\r\n]+)" +%\*$/i.exec(script)?.[1];
    const target = native || node;
    if (!target || !/^node_modules\\(?:@[\w.-]+\\)?[\w.-]+(?:\\[\w.@-]+)+$/i.test(target) ||
        target.split('\\').some((part) => part === '.' || part === '..')) return null;
    return executable(resolve(dirname(shim), target));
  } catch { return null; }
}

export function harnessLaunch(file: string, args: string[]) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(file)) return { file, args };
  const entry = npmEntry(file);
  if (!entry) return null;
  if (/\.exe$/i.test(entry)) return { file: entry, args };
  const node = [dirname(file), ...windowsPathDirectories(windowsEnv('PATH') ?? '')]
    .map((dir) => join(dir, 'node.exe')).find((path) => executable(path)) ?? process.execPath;
  return { file: node, args: [entry, ...args], ...(node === process.execPath && process.versions.electron
    ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
}
