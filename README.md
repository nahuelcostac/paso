# Paso

Run `pnpm install` and `pnpm dev` to start the app. Use `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` to check it.

The local service API, session authentication, data directory and compiled-server check are documented in [docs/server-api.md](docs/server-api.md).

The stdio board tools, harness configuration and optional step images are documented in [docs/mcp.md](docs/mcp.md).

## Install on Windows

Download `Paso-Setup-<version>-x64.exe` from [GitHub Releases](https://github.com/nahuelcostac/paso/releases) and run it on Windows 10 or 11 x64. The installer is unsigned. If SmartScreen blocks it, select **More info** → **Run anyway**. The installer runs per user and adds desktop and Start menu shortcuts. Uninstalling keeps the projects in `%APPDATA%\Paso\projects`.

To build from source, run `pnpm --filter '@paso/desktop' package` after installing the dependencies. On Windows the command writes the installer to `apps/desktop/dist/release/`. On macOS it builds an unsigned arm64 app bundle.

Set `PASO_DATA_DIR` before launching the desktop app to use a separate projects directory and profile.

## License

Paso is released under the [MIT License](LICENSE). Bundled fonts keep their own licenses: Inter, Excalifont and Liberation Sans are under the SIL Open Font License 1.1.
