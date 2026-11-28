// Windows code signing for releases, done by SignPath (docs/windows-signing.md). The release workflow
// runs this file first, as `node apps/desktop/signing.mjs`, to decide whether the release is signed.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateReleaseTag } from './version.mjs';

/** The secret and repository variables that turn signing on. Set all of them, or none. */
export const SIGNPATH_SETTINGS = [
  { name: 'SIGNPATH_API_TOKEN', kind: 'secret' },
  { name: 'SIGNPATH_ORGANIZATION_ID', kind: 'variable' },
  { name: 'SIGNPATH_PROJECT_SLUG', kind: 'variable' },
  { name: 'SIGNPATH_SIGNING_POLICY_SLUG', kind: 'variable' },
];

/** SignPath artifact configurations, one file each in .signpath/artifact-configurations/<slug>.xml. */
export const ARTIFACT_CONFIGURATIONS = { app: 'paso-app', installer: 'paso-installer' };

/** The certificate's subject must name this organization. SignPath Foundation is the publisher Windows shows. */
export const EXPECTED_PUBLISHER = 'SignPath Foundation';

export const UNSIGNED_WARNING = 'This release is not code signed: the SignPath secret and variables are not set in this repository. '
  + 'The workflow builds and publishes the unsigned installer. See docs/windows-signing.md to turn signing on.';

/**
 * The versions SignPath checks against each file's metadata, as electron-builder writes them:
 * the installer's ProductVersion is the package version as it is, and Paso.exe's is the four-part
 * Windows form, X.Y.Z.0, without any prerelease suffix.
 */
export function signingVersions(tag) {
  const version = tag.replace(/^v/, '');
  const [core] = version.split('-');
  return { version, windowsVersion: `${core}.0` };
}

/**
 * Signing is on when every SignPath setting is present, and off when none is, as in forks and before
 * SignPath approves the project. A partial setup is an error, so a typo cannot ship an unsigned release.
 */
export function signingMode(present) {
  const missing = SIGNPATH_SETTINGS.filter(({ name }) => !present[name]);
  if (missing.length === SIGNPATH_SETTINGS.length) return { enabled: false };
  if (missing.length > 0) {
    const list = missing.map(({ name, kind }) => `${name} (${kind})`).join(', ');
    throw new Error(`SignPath signing is only partly configured. Missing: ${list}. Set them all, or remove them all to publish unsigned.`);
  }
  return { enabled: true };
}

function main(env) {
  const tag = env.RELEASE_TAG ?? '';
  validateReleaseTag(tag);
  const present = Object.fromEntries(SIGNPATH_SETTINGS.map(({ name }) => [
    name, name === 'SIGNPATH_API_TOKEN' ? env.SIGNPATH_API_TOKEN_SET === 'true' : Boolean(env[name]),
  ]));
  const { enabled } = signingMode(present);
  const { version, windowsVersion } = signingVersions(tag);
  const outputs = [`enabled=${enabled}`, `version=${version}`, `windows-version=${windowsVersion}`];
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  else console.log(outputs.join('\n'));
  const summary = enabled
    ? `### Windows signing\n\nSigning ${tag} with SignPath. Each signing request waits for manual approval in SignPath.\n`
    : `### Windows signing\n\n> [!WARNING]\n> ${UNSIGNED_WARNING}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (!enabled) console.log(`::warning title=Unsigned release::${UNSIGNED_WARNING}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.env);
