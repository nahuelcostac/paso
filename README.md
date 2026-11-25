# Paso

Run `pnpm install` and `pnpm dev` to start the app. Use `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` to check it.

The local service API, session authentication, data directory and compiled-server check are documented in [docs/server-api.md](docs/server-api.md).

The stdio board tools, harness configuration and optional step images are documented in [docs/mcp.md](docs/mcp.md).

## Desktop packaging

Run `pnpm --filter '@paso/desktop' package` on Windows or macOS. On Windows it writes the unsigned Windows 10/11 x64 NSIS installer to
`apps/desktop/dist/release/Paso-Setup-0.0.0-x64.exe`. The installer runs per user and adds desktop and Start menu shortcuts. Uninstalling
keeps the projects in `%APPDATA%\Paso\projects`. On macOS the command builds the unsigned arm64 app bundle.

Set `PASO_DATA_DIR` before launching the desktop app to use a separate projects directory and profile.

## License

Paso is released under the [MIT License](LICENSE). Bundled fonts keep their own licenses: Inter, Excalifont and Liberation Sans are under the SIL Open Font License 1.1.
