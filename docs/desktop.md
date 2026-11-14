# Desktop prototype

Paso uses Electron for this proof on macOS. The service already runs in Node and can be embedded in the Electron main process. The references studied, Oleafly and Lattice, use Tauri. Oleafly uses a Rust backend through IPC. Lattice bundles its frontend and supervises a separate loopback Node runtime with fresh tokens and process-group cleanup. Tauri would need a Node sidecar or a backend rewrite for Paso. Its shell can be smaller.

## Build and run

Use Node 22.14.0 and pnpm 10.28.2 on Apple Silicon macOS. Run `pnpm install`, then `pnpm --filter @paso/desktop package`. Open `apps/desktop/dist/release/mac-arm64/Paso.app`. This produces an unsigned application directory, not a signed installer. The package bundles the service and MCP CLI with esbuild and uses Electron as the MCP Node runtime. The measured prototype was 819 MB on disk. A reduced arm64 build measured 292 MB with `du -sh`. Output and binaries are not committed.

The service listens on a free loopback port and creates a new token on each launch. Electron intercepts local web asset requests and serves the built UI from the app. API and WebSocket requests use the service origin. A sandboxed preload passes the token to the web client through a narrow synchronous bridge. The token is not in a URL, command line, or file. Context isolation and the renderer sandbox are enabled, Node integration is disabled, external renderer requests are blocked, and external HTTP links open in the system browser. Permission requests are denied.

Projects default to `~/Library/Application Support/Paso/projects`. Set `PASO_DATA_DIR` before launching the binary to override it. Registry, agent workspace, sessions and run records are stored alongside that projects directory. For an isolated check, use a new temporary parent directory.

The existing harness detector searches PATH, common installation locations and the login shell, including when the app starts from Finder. The package includes the bundled MCP server and renderer. The MCP process uses the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`, passed to the MCP child for both harnesses. The renderer and MCP share the web app's local Excalidraw fonts through relative links. Electron locales are limited to English and Spanish. No separate Node binary or production `node_modules` tree is shipped. The service closes agent process groups before it closes its listener when the app quits. The optional MCP image renderer needs a compatible Chromium executable and is not configured by this prototype. The agent can still read the layout and edit the board.

## Before a release

Add a product icon and support and test Intel or universal builds. Add signing, hardened runtime, notarization and a distribution format. Decide on update delivery and migration. Test upgrades, multiple instances, crash recovery, accessibility, external links and offline behavior in a release environment. Windows and Linux need their own packaging, data paths, process handling and verification. Review the desktop security boundary and bundled dependency licenses. The agent's optional image tool needs a packaged compatible renderer or a desktop rendering bridge.
