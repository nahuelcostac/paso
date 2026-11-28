import { join } from 'node:path';

/** Paso's additions to the NSIS installer: the install folder and no kept installer copy (installer.nsh). */
export const NSIS_INCLUDE = join(import.meta.dirname, 'installer.nsh');

export function packagingConfig(platform, icon, output, electronVersion) {
  const common = {
    electronVersion, appId: 'org.paso.prototype', productName: 'Paso', electronLanguages: ['en'],
    asar: false, directories: { output }, files: ['**/*'],
  };
  if (platform === 'darwin') return {
    targets: ['dir'],
    buildOptions: { ...common, mac: { target: ['dir'], identity: null, icon } },
  };
  return {
    targets: ['nsis'],
    buildOptions: {
      ...common,
      win: { target: [{ target: 'nsis', arch: ['x64'] }], icon, signExecutable: false },
      nsis: {
        artifactName: 'Paso-Setup-${version}-${arch}.exe',
        perMachine: false, oneClick: true, runAfterFinish: false, deleteAppDataOnUninstall: false,
        createStartMenuShortcut: true, createDesktopShortcut: true, shortcutName: 'Paso',
        include: NSIS_INCLUDE,
      },
    },
  };
}
