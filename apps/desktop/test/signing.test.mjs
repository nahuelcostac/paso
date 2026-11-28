import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AppInfo } from 'electron-builder';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { packagingConfig } from '../packaging-config.mjs';
import {
  ARTIFACT_CONFIGURATIONS, EXPECTED_PUBLISHER, SIGNPATH_SETTINGS, UNSIGNED_WARNING, signingMode, signingVersions,
} from '../signing.mjs';
import repoManifest from '../../../package.json' with { type: 'json' };

const repo = resolve(import.meta.dirname, '../../..');
const run = promisify(execFile);
const readWorkflow = async (name) => yaml.load(await readFile(join(repo, '.github/workflows', name), 'utf8'));
const readText = (path) => readFile(join(repo, path), 'utf8');
const steps = (job) => job.steps ?? [];
const signingSteps = (workflow) => Object.entries(workflow.jobs).flatMap(([id, job]) =>
  steps(job).filter((step) => step.uses?.startsWith('signpath/')).map((step) => ({ id, job, step })));
const allPresent = Object.fromEntries(SIGNPATH_SETTINGS.map(({ name }) => [name, true]));

describe('signing mode', () => {
  it('is off when no SignPath setting exists, as in forks', () => {
    expect(signingMode({})).toEqual({ enabled: false });
  });

  it('is on when every SignPath setting exists', () => {
    expect(signingMode(allPresent)).toEqual({ enabled: true });
  });

  it('fails on a partial setup and names what is missing', () => {
    expect(() => signingMode({ ...allPresent, SIGNPATH_PROJECT_SLUG: false, SIGNPATH_API_TOKEN: false }))
      .toThrow('Missing: SIGNPATH_API_TOKEN (secret), SIGNPATH_PROJECT_SLUG (variable)');
  });
});

describe('signing versions', () => {
  it.each([['v0.1.0-rc.1', '0.1.0-rc.1', '0.1.0.0'], ['v2.3.4', '2.3.4', '2.3.4.0'], ['v1.0.0-beta.12', '1.0.0-beta.12', '1.0.0.0']])(
    '%s gives the versions electron-builder writes into the installer and Paso.exe', (tag, version, windowsVersion) => {
      expect(signingVersions(tag)).toEqual({ version, windowsVersion });
      // The same calls electron-builder makes: NSIS ProductVersion is appInfo.version, and the exe's is
      // getVersionInWeirdWindowsForm(), which resedit then writes as the string too.
      const info = new AppInfo({ metadata: { name: 'paso-desktop', version }, config: { productName: 'Paso' }, devMetadata: {} });
      expect(info.version).toBe(version);
      expect(info.getVersionInWeirdWindowsForm()).toBe(windowsVersion);
    });
});

describe('signing.mjs in the workflow', () => {
  let dir;
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  async function runMode(env) {
    dir = await mkdtemp(join(tmpdir(), 'paso-signing-'));
    const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    const result = await run(process.execPath, [join(repo, 'apps/desktop/signing.mjs')], {
      env: { PATH: process.env.PATH, ...files, ...env },
    }).catch((error) => error);
    const read = (file) => readFile(file, 'utf8').catch(() => '');
    return { ...result, output: await read(files.GITHUB_OUTPUT), summary: await read(files.GITHUB_STEP_SUMMARY) };
  }

  it('publishes unsigned with a warning when nothing is set', async () => {
    const tag = `v${repoManifest.version}`;
    const result = await runMode({ RELEASE_TAG: tag, SIGNPATH_API_TOKEN_SET: 'false' });
    expect(result.code).toBeUndefined();
    expect(result.output).toBe(`enabled=false\nversion=${repoManifest.version}\nwindows-version=${signingVersions(tag).windowsVersion}\n`);
    expect(result.summary).toContain(UNSIGNED_WARNING);
    expect(result.stdout).toContain(`::warning title=Unsigned release::${UNSIGNED_WARNING}`);
  });

  it('signs when everything is set', async () => {
    const result = await runMode({
      RELEASE_TAG: `v${repoManifest.version}`, SIGNPATH_API_TOKEN_SET: 'true',
      SIGNPATH_ORGANIZATION_ID: 'org', SIGNPATH_PROJECT_SLUG: 'paso', SIGNPATH_SIGNING_POLICY_SLUG: 'release-signing',
    });
    expect(result.code).toBeUndefined();
    expect(result.output).toMatch(/^enabled=true\n/);
    expect(result.summary).not.toContain('WARNING');
  });

  it('fails a partial setup and a tag that does not match the version', async () => {
    const partial = await runMode({ RELEASE_TAG: `v${repoManifest.version}`, SIGNPATH_API_TOKEN_SET: 'true' });
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('SignPath signing is only partly configured');
    expect(partial.output).toBe('');
    const wrongTag = await runMode({ RELEASE_TAG: 'v99.0.0', SIGNPATH_API_TOKEN_SET: 'false' });
    expect(wrongTag.code).toBe(1);
    expect(wrongTag.stderr).toContain('does not match version');
  });
});

describe('release workflow', () => {
  it('pins every action to a full commit SHA with its version', async () => {
    for (const name of ['release.yml', 'windows.yml']) {
      const source = await readText(`.github/workflows/${name}`);
      const uses = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)].filter(([, ref]) => !ref.startsWith('./'));
      expect(uses.length).toBeGreaterThan(0);
      for (const [line, ref, comment] of uses) {
        expect(ref, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(comment, line).toMatch(/^ # v\d+(\.\d+)*$/);
      }
    }
  });

  it('gives write access only to publishing, and actions:read only to the SignPath jobs', async () => {
    const workflow = await readWorkflow('release.yml');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const signingJobs = new Set(signingSteps(workflow).map(({ id }) => id));
    expect([...signingJobs].sort()).toEqual(['sign-app', 'sign-installer']);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === 'publish') expect(job.permissions).toEqual({ contents: 'write' });
      else if (signingJobs.has(id)) expect(job.permissions).toEqual({ actions: 'read', contents: 'read' });
      else expect(job.permissions).toBeUndefined();
    }
    expect((await readWorkflow('windows.yml')).permissions).toEqual({ contents: 'read' });
  });

  it('runs every job on GitHub-hosted runners, as SignPath requires for open source', async () => {
    const workflow = await readWorkflow('release.yml');
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job.uses) expect(job.uses, id).toBe('./.github/workflows/windows.yml');
      else expect(['ubuntu-latest', 'windows-latest'], id).toContain(job['runs-on']);
    }
    expect((await readWorkflow('windows.yml')).jobs.installer['runs-on']).toBe('windows-latest');
  });

  it('reads the SignPath secret and variables only where signing needs them, from the signpath environment', async () => {
    const source = await readText('.github/workflows/release.yml');
    const workflow = yaml.load(source);
    expect(source.match(/secrets\.SIGNPATH_API_TOKEN/g)).toHaveLength(3);
    for (const { job, step } of signingSteps(workflow)) {
      expect(job.environment).toBe('signpath');
      expect(step.with).toMatchObject({
        'api-token': '${{ secrets.SIGNPATH_API_TOKEN }}',
        'organization-id': '${{ vars.SIGNPATH_ORGANIZATION_ID }}',
        'project-slug': '${{ vars.SIGNPATH_PROJECT_SLUG }}',
        'signing-policy-slug': '${{ vars.SIGNPATH_SIGNING_POLICY_SLUG }}',
        'wait-for-completion': true,
      });
    }
    const mode = workflow.jobs.signing;
    expect(mode.environment).toBe('signpath');
    const modeEnv = steps(mode).find((step) => step.id === 'mode').env;
    expect(modeEnv.SIGNPATH_API_TOKEN_SET).toBe("${{ secrets.SIGNPATH_API_TOKEN != '' }}");
    for (const { name, kind } of SIGNPATH_SETTINGS.filter(({ kind }) => kind === 'variable')) {
      expect(modeEnv[name], `${name} (${kind})`).toBe(`\${{ vars.${name} }}`);
    }
    // Jobs that install dependencies or run the build never see the secret.
    for (const id of ['installer', 'installer-from-signed-app', 'publish']) {
      expect(JSON.stringify(workflow.jobs[id])).not.toContain('secrets.');
    }
  });

  it('signs the app, builds the installer from it, then signs and checks the installer before publishing', async () => {
    const { jobs, env } = await readWorkflow('release.yml');
    expect(env.SIGNING_PUBLISHER).toBe(EXPECTED_PUBLISHER);
    expect(jobs.installer.with['upload-app']).toBe("${{ needs.signing.outputs.enabled == 'true' }}");
    expect(jobs['sign-app'].if).toBe("needs.signing.outputs.enabled == 'true'");
    expect(jobs['sign-app'].needs).toEqual(['signing', 'installer']);
    expect(jobs['installer-from-signed-app'].needs).toBe('sign-app');
    expect(jobs['sign-installer'].needs).toEqual(['signing', 'installer-from-signed-app']);
    expect(jobs.publish.needs).toEqual(['signing', 'installer', 'sign-installer']);
    expect(jobs.publish.if).toContain("needs.sign-installer.result == 'success'");

    const app = signingSteps({ jobs: { 'sign-app': jobs['sign-app'] } })[0].step.with;
    expect(app['github-artifact-id']).toBe('${{ needs.installer.outputs.app-artifact-id }}');
    expect(app['output-artifact-directory']).toBe('signed-app');
    const build = steps(jobs['installer-from-signed-app']);
    expect(build.map((step) => step.run).filter(Boolean)).toContain('node apps/desktop/package.mjs --prepackaged signed-app');
    const installer = signingSteps({ jobs: { 'sign-installer': jobs['sign-installer'] } })[0].step.with;
    expect(installer['github-artifact-id']).toBe('${{ needs.installer-from-signed-app.outputs.artifact-id }}');

    for (const id of ['sign-app', 'installer-from-signed-app', 'sign-installer']) {
      expect(steps(jobs[id]).some((step) => step.run?.includes('scripts/verify-authenticode.ps1')), id).toBe(true);
    }
    const download = steps(jobs.publish).find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.with.name).toBe("${{ needs.signing.outputs.enabled == 'true' && 'Paso-Windows-x64-signed' || 'Paso-Windows-x64' }}");
  });

  it('uploads the unpacked app from the Windows build only when the release asks for it', async () => {
    const workflow = await readWorkflow('windows.yml');
    expect(workflow.on.workflow_call.inputs['upload-app']).toMatchObject({ type: 'boolean', default: false });
    expect(workflow.on.workflow_call.outputs['app-artifact-id'].value).toBe('${{ jobs.installer.outputs.app-artifact-id }}');
    const upload = steps(workflow.jobs.installer).find((step) => step.id === 'upload-app');
    expect(upload.if).toBe('inputs.upload-app');
    expect(upload.with.path).toBe('apps/desktop/dist/release/win-unpacked/');
  });
});

describe('SignPath artifact configurations', () => {
  const configDir = join(repo, '.signpath/artifact-configurations');
  const parse = (xml) => ({
    namespace: xml.match(/<artifact-configuration xmlns="([^"]+)">/)?.[1],
    parameters: [...xml.matchAll(/<parameter name="([^"]+)" required="true" \/>/g)].map(([, name]) => name),
    files: [...xml.matchAll(/<pe-file ([^>]*)>\s*<authenticode-sign \/>\s*<\/pe-file>/g)]
      .map(([, attributes]) => Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))),
  });

  it('has one file per slug the workflow uses', async () => {
    const files = (await readdir(configDir)).sort();
    expect(files).toEqual(Object.values(ARTIFACT_CONFIGURATIONS).map((slug) => `${slug}.xml`).sort());
    const workflow = await readWorkflow('release.yml');
    const slugs = signingSteps(workflow).map(({ step }) => step.with['artifact-configuration-slug']).sort();
    expect(slugs).toEqual(Object.values(ARTIFACT_CONFIGURATIONS).sort());
  });

  it('declares exactly the parameters the workflow passes', async () => {
    const workflow = await readWorkflow('release.yml');
    for (const { step } of signingSteps(workflow)) {
      const slug = step.with['artifact-configuration-slug'];
      const { namespace, parameters } = parse(await readFile(join(configDir, `${slug}.xml`), 'utf8'));
      expect(namespace).toBe('http://signpath.io/artifact-configuration/v1');
      const passed = step.with.parameters.trim().split('\n').map((line) => line.split(':')[0].trim());
      expect(passed, slug).toEqual(parameters);
    }
  });

  it('signs Paso.exe and the NSIS installer by the names electron-builder gives them, with Paso as product name', async () => {
    const { buildOptions } = packagingConfig('win32', 'paso.svg', 'release', '45.4.1');
    const app = parse(await readFile(join(configDir, `${ARTIFACT_CONFIGURATIONS.app}.xml`), 'utf8'));
    expect(app.files).toEqual([{ path: `${buildOptions.productName}.exe`, 'product-name': buildOptions.productName, 'product-version': '${windowsVersion}' }]);
    const installer = parse(await readFile(join(configDir, `${ARTIFACT_CONFIGURATIONS.installer}.xml`), 'utf8'));
    const installerName = buildOptions.nsis.artifactName.replace('${arch}', buildOptions.win.target[0].arch[0]);
    expect(installer.files).toEqual([{ path: installerName, 'product-name': buildOptions.productName, 'product-version': '${version}' }]);
  });
});

describe('code signing policy', () => {
  it('is on the home page with the SignPath attribution, team roles and privacy statement', async () => {
    const readme = await readText('README.md');
    const policy = readme.slice(readme.indexOf('## Code signing policy'), readme.indexOf('## License'));
    expect(policy).toContain('Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).');
    expect(policy).toMatch(/Committers and reviewers: \[\w+\]/);
    expect(policy).toMatch(/Approvers: \[\w+\]/);
    expect(policy).toContain('This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.');
    const release = await readText('.github/workflows/release.yml');
    expect(release).toContain('#code-signing-policy');
  });

  it('documents every setting the workflow reads', async () => {
    const docs = await readText('docs/windows-signing.md');
    for (const { name } of SIGNPATH_SETTINGS) expect(docs).toContain(`| \`${name}\` |`);
    for (const slug of Object.values(ARTIFACT_CONFIGURATIONS)) expect(docs).toContain(`\`${slug}\``);
  });
});
