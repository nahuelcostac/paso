# Paso

Run `pnpm install` and `pnpm dev` to start the app. Use `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` to check it.

The local service API, session authentication, data directory and compiled-server check are documented in [docs/server-api.md](docs/server-api.md).

The stdio board tools, harness configuration and optional step images are documented in [docs/mcp.md](docs/mcp.md).

## Install on Windows

Download `Paso-Setup-<version>-x64.exe` from [GitHub Releases](https://github.com/nahuelcostac/paso/releases) and run it on Windows 10 or 11 x64. Each release's notes say whether it is signed (see the [code signing policy](#code-signing-policy)). Releases up to v0.1.0-rc.1 are unsigned: if SmartScreen blocks one, select **More info** → **Run anyway**. The installer runs per user and adds desktop and Start menu shortcuts. Uninstalling keeps the projects in `%APPDATA%\Paso\projects`.

To build from source, run `pnpm --filter '@paso/desktop' package` after installing the dependencies. On Windows the command writes the installer to `apps/desktop/dist/release/`. On macOS it builds an unsigned arm64 app bundle.

Set `PASO_DATA_DIR` before launching the desktop app to use a separate projects directory and profile.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Status: Paso is applying to SignPath Foundation. Releases up to v0.1.0-rc.1 are unsigned, and the notes of each release say whether it is signed.

What is signed: `Paso.exe` and the installer, `Paso-Setup-<version>-x64.exe`. GitHub Actions builds both on GitHub-hosted runners from the tagged commit of this repository ([release workflow](.github/workflows/release.yml)), and SignPath signs them. The Electron libraries Paso ships are Electron's own files and stay as Electron publishes them. How it works: [docs/windows-signing.md](docs/windows-signing.md).

Team roles:

- Committers and reviewers: [nahuelcostac](https://github.com/nahuelcostac)
- Approvers: [nahuelcostac](https://github.com/nahuelcostac)

Changes from anyone else, including changes written by AI coding agents, arrive as pull requests, and a committer reviews each one before merging it. Every signing request is approved by hand in SignPath. Team members use multi-factor authentication for GitHub and SignPath.

### Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Paso's local service listens only on the loopback address (127.0.0.1), and the app talks only to it. Paso sends no telemetry or crash reports and does not check for updates. Projects stay on your computer, in Paso's data folder or a folder you choose. A link opens in your web browser only when you click it. When you chat with an agent in Paso, Paso starts the coding agent you picked (Claude Code, Codex or Antigravity), which you installed and signed in to yourself. That program sends your messages, and the board content it reads through Paso's board tools, to its provider under that provider's terms. Paso stores no API keys.

## License

Paso is released under the [MIT License](LICENSE). Bundled fonts keep their own licenses: Inter, Excalifont and Liberation Sans are under the SIL Open Font License 1.1.
