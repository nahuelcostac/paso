import { expect, it } from 'vitest';
import { packagingConfig } from '../packaging-config.mjs';

it('packages an unsigned, per-user Windows x64 installer with shortcuts and keeps user data on uninstall', () => {
  const { targets, buildOptions } = packagingConfig('win32', 'paso.svg', 'release', '45.4.1');
  expect(targets).toEqual(['nsis']);
  expect(buildOptions.win).toEqual({ target: [{ target: 'nsis', arch: ['x64'] }], icon: 'paso.svg', signExecutable: false });
  expect(buildOptions.nsis).toMatchObject({
    artifactName: 'Paso-Setup-${version}-${arch}.exe', perMachine: false, runAfterFinish: false,
    createStartMenuShortcut: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false,
  });
});

it('keeps the macOS directory target and icon', () => {
  const { targets, buildOptions } = packagingConfig('darwin', 'Paso.icns', 'release', '45.4.1');
  expect(targets).toEqual(['dir']);
  expect(buildOptions.mac).toEqual({ target: ['dir'], identity: null, icon: 'Paso.icns' });
  expect(buildOptions.nsis).toBeUndefined();
});
