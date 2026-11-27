import repoManifest from '../../package.json' with { type: 'json' };

export const appVersion = repoManifest.version;

const number = '(?:0|[1-9][0-9]*)';
const releaseTag = new RegExp(`^v${number}\\.${number}\\.${number}(?:-(?:rc|beta)\\.${number})?$`);

export function validateReleaseTag(tag, version = appVersion) {
  if (!releaseTag.test(tag)) {
    throw new Error(`Invalid Paso release tag "${tag}". Use vX.Y.Z, vX.Y.Z-rc.N, or vX.Y.Z-beta.N.`);
  }
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag "${tag}" does not match version "${version}" in the root package.json. Expected "${expected}".`);
  }
}
