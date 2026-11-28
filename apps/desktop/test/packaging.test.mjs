import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { NSIS_INCLUDE, packagingConfig } from '../packaging-config.mjs';
import { appVersion, validateReleaseTag } from '../version.mjs';
import repoManifest from '../../../package.json' with { type: 'json' };

it('packages an unsigned, per-user Windows x64 installer with shortcuts and keeps user data on uninstall', () => {
  const { targets, buildOptions } = packagingConfig('win32', 'paso.svg', 'release', '45.4.1');
  expect(targets).toEqual(['nsis']);
  expect(buildOptions.win).toEqual({ target: [{ target: 'nsis', arch: ['x64'] }], icon: 'paso.svg', signExecutable: false });
  expect(buildOptions.nsis).toMatchObject({
    artifactName: 'Paso-Setup-${version}-${arch}.exe', perMachine: false, runAfterFinish: false,
    createStartMenuShortcut: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false,
  });
});

it('installs to Programs\\Paso, also over 0.1.0-rc.1 in Programs\\paso-desktop, and keeps no installer copy', async () => {
  const { buildOptions } = packagingConfig('win32', 'paso.svg', 'release', '45.4.1');
  expect(buildOptions.nsis.include).toBe(NSIS_INCLUDE);
  const script = await readFile(NSIS_INCLUDE, 'utf8');
  const macro = (name) => script.match(new RegExp(`!macro ${name}\\r?\\n([\\s\\S]*?)!macroend`))?.[1] ?? '';
  // The default folder (from the package name) and the one rc.1 recorded both end in paso-desktop.
  expect(macro('customInit')).toMatch(/\$\{GetFileName\} "\$INSTDIR" \$R0\s+\$\{If\} \$R0 == "paso-desktop"\s+\$\{GetParent\} "\$INSTDIR" \$R1\s+StrCpy \$INSTDIR "\$R1\\Paso"/);
  expect(macro('customInstall')).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
  // RMDir without /r only removes the folder when nothing else is in it.
  expect(macro('customInstall')).toMatch(/RMDir "\$R0"/);
  expect(script).not.toMatch(/RMDir \/r/);
});

it('uses the Paso version and NSIS target architecture in the installer name', () => {
  const { buildOptions } = packagingConfig('win32', 'paso.svg', 'release', '45.4.1');
  const installer = buildOptions.nsis.artifactName
    .replace('${version}', appVersion)
    .replace('${arch}', buildOptions.win.target[0].arch[0]);
  expect(installer).toBe(`Paso-Setup-${repoManifest.version}-x64.exe`);
});

it('keeps the macOS directory target and icon', () => {
  const { targets, buildOptions } = packagingConfig('darwin', 'Paso.icns', 'release', '45.4.1');
  expect(targets).toEqual(['dir']);
  expect(buildOptions.mac).toEqual({ target: ['dir'], identity: null, icon: 'Paso.icns' });
  expect(buildOptions.nsis).toBeUndefined();
  expect(buildOptions).toEqual({
    electronVersion: '45.4.1', appId: 'org.paso.prototype', productName: 'Paso', electronLanguages: ['en'],
    asar: false, directories: { output: 'release' }, files: ['**/*'], mac: buildOptions.mac,
  });
});

it('accepts the tag for the current repository version', () => {
  expect(() => validateReleaseTag(`v${repoManifest.version}`)).not.toThrow();
});

it.each(['2.3.4-rc.1', '2.3.4-beta.2'])('accepts the matching prerelease tag for %s', (version) => {
  expect(() => validateReleaseTag(`v${version}`, version)).not.toThrow();
});

it.each(['v2.3.5', 'v2.3.4-rc.1', 'v2.3.4-beta.2'])('rejects %s for a different version', (tag) => {
  expect(() => validateReleaseTag(tag, '2.3.4')).toThrow('Expected "v2.3.4"');
});

it.each(['2.3.4', 'v02.3.4', 'v2.3.4-rc', 'v2.3.4-beta.01'])('rejects invalid tag %s', (tag) => {
  expect(() => validateReleaseTag(tag, tag.slice(1))).toThrow('Invalid Paso release tag');
});
