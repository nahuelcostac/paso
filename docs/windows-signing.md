# Windows code signing

Paso's Windows releases are Authenticode signed through [SignPath Foundation](https://signpath.org), which signs open source projects for free. Windows then shows a known publisher, and ESC-11's updater can check that an update comes from the same publisher. The certificate belongs to SignPath Foundation, so Windows shows **SignPath Foundation** as the publisher, not Paso or a person.

The release workflow does the signing with no manual steps besides approving each signing request in SignPath. Until the secret and variables below exist, it publishes unsigned releases, as v0.1.0-rc.1 was.

## What SignPath Foundation requires

From the [conditions for open source projects](https://signpath.org/terms.html) (the page is marked as a draft, so check it again before applying):

- **Eligibility.** An OSI-approved licence with no commercial dual licensing (Paso is MIT), no proprietary components, no malware or unwanted software, actively maintained, already released in the form to be signed (v0.1.0-rc.1 is), and its functionality described on the download page.
- **Sign only your own binaries.** The team must maintain all the source code and build scripts. Binaries from other projects must not be signed with Paso's certificate, but unsigned upstream libraries may ship inside a signed package. This is why the workflow signs `Paso.exe` and the installer and leaves Electron's DLLs as Electron publishes them (none of them is signed, apart from Microsoft's `d3dcompiler_47.dll`). SignPath asks for as much signing coverage as possible and may require signed libraries in future.
- **Verifiable builds.** Binaries must be built from the repository's source in a verifiable way. On GitHub that means GitHub Actions with SignPath's GitHub.com trusted build system, and for open source projects every job leading up to a signing request must run on a GitHub-hosted runner ([GitHub integration](https://docs.signpath.io/trusted-build-systems/github), [origin verification](https://docs.signpath.io/origin-verification)). All of Paso's release jobs do.
- **A code signing policy on the project's home page**, with the sentence "Free code signing provided by SignPath.io, certificate by SignPath Foundation", the team roles (committers and reviewers, approvers) and a privacy statement. It is the [Code signing policy](../README.md#code-signing-policy) section of the README, which is the home page on GitHub. Release notes link to it.
- **Roles.** Committers change the code without further review, every change from anyone else is reviewed by a team member, and an approver approves **every** signing request by hand.
- **Multi-factor authentication** for every team member, on both SignPath and GitHub.
- **File metadata.** Every signed file must have its product name set to the project's name and its product version set to the build's version, enforced with SignPath's metadata restrictions. The artifact configurations below check both.

Other pages used: [apply](https://signpath.org/apply), [artifact configuration syntax](https://docs.signpath.io/artifact-configuration/syntax) and [reference](https://docs.signpath.io/artifact-configuration/reference), [projects and signing policies](https://docs.signpath.io/projects), [trusted build systems](https://docs.signpath.io/trusted-build-systems), [pipeline policies](https://docs.signpath.io/pipeline-policies), and the action's [README](https://github.com/SignPath/github-action-submit-signing-request).

## How a release is signed

`.github/workflows/release.yml`, on a `vX.Y.Z` tag:

1. **Signing setup** (`apps/desktop/signing.mjs`) checks the tag and decides whether this release is signed. Signing is on when all four settings below exist and off when none does. If only some exist, the release fails and names the missing ones.
2. **installer** runs the Windows checks and builds as before (`windows.yml`). With signing on, it also uploads the unpacked app, electron-builder's `win-unpacked` folder.
3. **Sign Paso.exe** sends that folder to SignPath with the `paso-app` artifact configuration and waits up to four hours for approval. It then checks the signature of `Paso.exe`.
4. **Build the installer from the signed app** runs `node apps/desktop/package.mjs --prepackaged signed-app`. electron-builder packs the folder as it is, so the installer carries the signed `Paso.exe`.
5. **Sign the installer** sends the installer to SignPath with `paso-installer` and waits for the second approval. It checks the installer's signature, installs it silently on the runner and checks the installed `Paso.exe`.
6. **publish** attaches the signed installer to the GitHub release. Its notes say it is signed, with the SignPath attribution and a link to the policy.

Without signing, steps 3 to 5 are skipped and `publish` attaches the unsigned installer from step 2. A warning appears in the run's summary and the release notes say the installer is unsigned. This keeps forks and today's releases working. A release that is meant to be signed cannot silently go out unsigned, because a partial setup fails, and once the settings exist, any failed signing request or signature check stops the release.

Each check (`scripts/verify-authenticode.ps1`) requires `Get-AuthenticodeSignature` to report `Valid`, a certificate whose organization is SignPath Foundation, and a timestamp, so the signature stays valid after the certificate expires. A test-signing certificate is not trusted on the runner, so a release signed with it fails on purpose instead of being published.

### Why this order

Windows checks the signature of the program it runs, not only the installer's. A signed `Paso.exe` is what Windows sees on every launch, for example with Smart App Control. The installer is an NSIS program with the app compressed inside it, and SignPath cannot open NSIS installers to sign the files inside. So the app is signed first, the installer is built from the signed app, and the installer is signed last. electron-builder's `--prepackaged` option packs a folder without editing it. A local test packed a modified `Paso.exe` this way and the copy inside the installer's archive had the same SHA-256.

The other choice was to sign only the installer, as some Electron projects do. That needs a single approval, but leaves the installed program unsigned. The cost of this order is two approvals per release, a few minutes apart.

## Before applying

1. Merge this change, so that the README shows the code signing policy.
2. Turn on two-factor authentication for your GitHub account, if it is not on already (GitHub → Settings → Password and authentication).
3. Optional but recommended: add a tag ruleset (Settings → Rules → Rulesets → New tag ruleset) that targets `v*` and restricts creation, update and deletion to you, so only you can start a release.

## Applying

Open [signpath.org/apply](https://signpath.org/apply) and apply in your own name. The form loads in the browser, so its exact questions could not be read. These drafts cover what SignPath's conditions ask about.

- **Project name:** Paso
- **Repository:** https://github.com/nahuelcostac/paso
- **Home page and download page:** https://github.com/nahuelcostac/paso (README) and https://github.com/nahuelcostac/paso/releases
- **Licence:** MIT, for all of Paso's code. Bundled fonts are under the SIL Open Font License 1.1.
- **Description:** Paso is a local-first whiteboard editor built on Excalidraw, for explaining concepts step by step and presenting them. People and their own AI coding agents edit the same boards. It runs as a web app and as an Electron desktop app for Windows.
- **What to sign:** `Paso.exe`, the Electron app executable with Paso's name, version and icon, and the NSIS installer `Paso-Setup-<version>-x64.exe`. Both are built by electron-builder on GitHub-hosted runners from tagged commits. The installer contains Electron's runtime libraries unchanged and unsigned.
- **Build system:** GitHub Actions, `.github/workflows/release.yml`, on GitHub-hosted runners, with the SignPath GitHub action.
- **Team:** one maintainer, nahuelcostac, who is committer, reviewer and approver. Changes written by AI coding agents arrive as pull requests that the maintainer reviews and merges.
- **Releases:** v0.1.0-rc.1, the first Windows prerelease, is published unsigned on GitHub Releases. Further releases follow the version in `package.json`.
- **Privacy:** the app makes no network connections beyond its local service on 127.0.0.1. It only starts an AI agent CLI that the user installed, when the user chats with it. See the README's Privacy section.
- **Why signing:** so Windows shows a known publisher instead of SmartScreen's unknown publisher warning, and so the coming auto-updater can verify updates.
- **Questions to ask SignPath:**
  - Is signing `Paso.exe` acceptable? It is Electron's executable with Paso's resources written into it by electron-builder.
  - Should `product-version` match the version string or the numeric version? `Paso.exe` reports `X.Y.Z.0` and the installer reports the package version, such as `0.1.0-rc.2`.
  - What should "Allowed branch names" be for builds started by a `v*` tag?

## After SignPath approves

SignPath gives you an organization for Paso. In it:

1. **MFA.** Turn on multi-factor authentication for your SignPath account.
2. **Trusted build system.** Add the predefined **GitHub.com** trusted build system to the organization, and link it to the Paso project (Project → Trusted build systems → Link).
3. **Project.** Note its slug and its repository URL, which must be `https://github.com/nahuelcostac/paso`.
4. **Artifact configurations.** Create two, with these exact slugs, pasting the XML from the repository:
   - `paso-app`: [.signpath/artifact-configurations/paso-app.xml](../.signpath/artifact-configurations/paso-app.xml)
   - `paso-installer`: [.signpath/artifact-configurations/paso-installer.xml](../.signpath/artifact-configurations/paso-installer.xml)

   SignPath keeps them in its own UI. The files in the repository are the reference, and tests check them against the workflow and the packaging config. If you change one, paste it again.
5. **Signing policy.** On `release-signing` (the policy with the SignPath Foundation certificate):
   - Approvers: you, with 1 required approval.
   - Trusted build system verification: on, with GitHub.com. Origin verification: on, with the repository URL above. Set **Allowed branch names** as SignPath advises for tag builds. The docs only give branch examples such as `main`.
   - Pipeline policy (if offered): `github-build-policies` with `runners: require_github_hosted: true`. `disallow_reruns: true` is safer but means a failed signing needs a new tag.
6. **CI user.** Create a CI user, make it a **Submitter** of `release-signing`, and create its API token. Copy the token straight into GitHub (next section), not into a file or chat.

## GitHub settings

Create an environment named `signpath` (Settings → Environments → New environment). Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*`. Only release tags can then read its values, and a workflow pushed to a branch cannot. Add these to the environment:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | The organization ID (SignPath → Organization → Settings) |
| Variable | `SIGNPATH_PROJECT_SLUG` | The project's slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |

Or, from a terminal signed in with `gh` (each command asks for the value):

```sh
gh secret set SIGNPATH_API_TOKEN --env signpath
gh variable set SIGNPATH_ORGANIZATION_ID --env signpath
gh variable set SIGNPATH_PROJECT_SLUG --env signpath
gh variable set SIGNPATH_SIGNING_POLICY_SLUG --env signpath --body release-signing
```

The workflow creates the environment on its first release run if it does not exist yet, but without the tag rule. So create it first. To go back to unsigned releases, delete all four values.

## Releasing

1. Set the version in the root `package.json` and merge it.
2. Push the tag, for example `git tag v0.1.0-rc.2 && git push origin v0.1.0-rc.2`.
3. SignPath asks you to approve the first request, for `Paso.exe`. Approve it in SignPath. The workflow then builds the installer, and about ten minutes later a second request arrives, for the installer. Approve it too. Both appear under Signing requests in SignPath. Each one waits up to four hours.
4. The release appears with the signed installer. On Windows, check it in PowerShell:

   ```powershell
   Get-AuthenticodeSignature .\Paso-Setup-0.1.0-rc.2-x64.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
   Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\*\Paso.exe" | Format-List Path, Status, SignerCertificate
   ```

   Both should report `Status: Valid` and a signer from SignPath Foundation. File Explorer shows the same under Properties → Digital Signatures.

If you deny a request or it times out, the run fails and nothing is published. Re-run the failed jobs, or push a new tag if reruns are disallowed.

## Known gaps

- **The uninstaller is not signed.** electron-builder writes `Uninstall Paso.exe` while building the NSIS installer and signs it only when it signs everything itself. Signing it here would need a third approval in the middle of the build. The installer check prints its status.
- **Electron's DLLs are not signed**, as described above.
- **ESC-11.** `latest.yml` and the `.blockmap` must be computed from the signed installer, after step 5, because signing changes its bytes and hash. The Privacy section must also say what the update check sends, before updates ship.
- **Not verified yet.** No release has been signed. The first signed release will be the first test of the SignPath requests, the metadata checks, origin verification for tag builds, and `Get-AuthenticodeSignature` reporting `Valid` on a real Windows machine.
