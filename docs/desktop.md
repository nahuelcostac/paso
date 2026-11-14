# Desktop prototype

Paso uses Electron for this proof on macOS. The service already runs in Node and can be embedded in the Electron main process. The references studied, Oleafly and Lattice, use Tauri. Oleafly uses a Rust backend through IPC. Lattice bundles its frontend and supervises a separate loopback Node runtime with fresh tokens and process-group cleanup. Tauri would need a Node sidecar or a backend rewrite for Paso. Its shell can be smaller.

## Build and run

Use Node 22.14.0 and pnpm 10.28.2 on Apple Silicon macOS. Run `pnpm install`, then `pnpm --filter @paso/desktop package`. Open `apps/desktop/dist/release/mac-arm64/Paso.app`. This produces an unsigned application directory, not a signed installer. The package bundles the service and MCP CLI with esbuild and uses Electron as the MCP Node runtime. The measured prototype was 819 MB on disk. A reduced arm64 build measured 292 MB with `du -sh`. Output and binaries are not committed.

The service listens on a free loopback port and creates a new token on each launch. Electron intercepts local web asset requests and serves the built UI from the app. API and WebSocket requests use the service origin. A sandboxed preload passes the token to the web client through a narrow synchronous bridge. The token is not in a URL, command line, or file. Context isolation and the renderer sandbox are enabled, Node integration is disabled, external renderer requests are blocked, and external HTTP links open in the system browser. Permission requests are denied, except full screen for the app's own origin, which Presentar needs.

Projects default to `~/Library/Application Support/Paso/projects`. Set `PASO_DATA_DIR` before launching the binary to override it. Registry, agent workspace, sessions and run records are stored alongside that projects directory. For an isolated check, use a new temporary parent directory.

The existing harness detector searches PATH, common installation locations and the login shell, including when the app starts from Finder. The package includes the bundled MCP server and renderer. The MCP process uses the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`, passed to the MCP child for both harnesses. The renderer and MCP share the web app's local Excalidraw fonts through relative links. Electron locales are limited to English and Spanish. No separate Node binary or production `node_modules` tree is shipped. The service closes agent process groups before it closes its listener when the app quits. The optional MCP image renderer needs a compatible Chromium executable and is not configured by this prototype. The agent can still read the layout and edit the board.

## macOS integration

The main process stays small: `main.mjs` wires the pieces in `apps/desktop/lib/`, which do not import Electron and are tested in Node (`apps/desktop/test/`).

- **Menu** (`lib/menu.mjs`). Paso, Archivo, Edición, Visualización, Ventana and Ayuda, with every label in Spanish. Standard items use Electron roles, so macOS runs them natively: ⌘Q quits, ⌘W closes the window, ⌘M minimizes and ⌃⌘F toggles full screen. On macOS the page sees each key before the menu, and the menu acts only on keys the page did not handle. So Excalidraw keeps its own ⌘Z, ⇧⌘Z and ⌘A on the canvas. Edición's roles send the edit command to whatever has focus, which fires the DOM `copy`, `cut` and `paste` events Excalidraw listens to and edits text fields as usual. The menu has no page zoom, because ⌘+, ⌘− and ⌘0 are Excalidraw's zoom on the canvas. Volver a cargar and the developer tools appear only outside the packaged app. Ayuda opens the data folder. Choosing Deshacer with the mouse while the canvas has focus does nothing, because Excalidraw's history only answers its keys. Use ⌘Z or the undo button on the canvas.
- **Closing the last window quits Paso**, even on macOS. Paso has one window, and the service, its loopback port and any agent run live in the app's process. If the app stayed in the Dock with no window, an agent could keep changing boards that nobody sees, which goes against agent changes appearing live on the canvas. Everything is already saved to disk, so reopening costs nothing.
- **One instance** (`lib/app-shell.mjs`). Launching Paso again focuses the existing window, restoring it from the Dock if needed, and the new process exits. The lock lives in the Electron profile, so an instance started with its own `PASO_DATA_DIR` is separate from the person's Paso.
- **Window state** (`lib/window-state.mjs`). The size, position and maximized state are saved in `window-state.json` in the profile when the window settles after a move or resize, and when it closes. The normal bounds are saved even while maximized or in full screen. At launch the window goes back where it was if at least 120 px of its title bar is on a connected display, and it is shrunk to fit that display. Otherwise, for example after a display was unplugged, it opens at the same size, centred on the main display. A missing or broken file gives the default 1400×900, centred.
- **Folder dialog** (`lib/folder-bridge.mjs`). «Nuevo workspace…» opens the system folder dialog as a sheet on the window, instead of the in-app explorer, which the browser version keeps. The preload exposes only `chooseFolder(near?)`. The main process answers only the app's own page, in the main frame of its window. It accepts only an absolute path or nothing as the starting folder, keeps one dialog open at a time, and returns a path only after the person picks one. The service still validates the folder when it is added, exactly as with the explorer.
- **«Abrir carpeta»** goes through the service's `openFolder` hook, which the desktop app sets to `shell.openPath`, so Finder opens the folder.
- **Full screen.** Presentar asks the page for full screen, and the window enters real macOS full screen (`isFullScreen()`, not simple full screen) and covers the whole display. Before this change the permission handler refused that request, so Presentar only filled the window.
- **Icon.** `apps/desktop/icon/paso.svg` is the source: the brand mark, a rising step on an ink tile, on Apple's 1024 grid. `node apps/desktop/icon/build.mjs` rebuilds `Paso.icns` with `sips` and `iconutil`, and packaging uses it.

## Checking that it stays offline

Launch the packaged binary with an isolated profile and Chromium's network log, and sample the sockets of the whole process tree:

```sh
PASO_DATA_DIR="$TMP/paso/projects" NODE_DEBUG=net,http,dns \
  apps/desktop/dist/release/mac-arm64/Paso.app/Contents/MacOS/Paso --log-net-log="$TMP/paso/netlog.json" --net-log-capture-mode=Everything
# in another shell, every 0.2 s: lsof -nP -a -i -p <Paso and its descendants>
```

In ESC-03's session (open a project, draw shapes and text, Presentar, 30 s idle, quit), every request, socket and `lsof` sample was on 127.0.0.1. The only other address in the net-log is `[2001:4860:4860::8888]:443`. That is Chromium's IPv6 reachability check: a UDP `connect()` that only picks a route. The log records no bytes sent or received on it.

## Before a release

Support and test Intel or universal builds. Add signing, hardened runtime, notarization and a distribution format. Decide on update delivery and migration. Test upgrades, crash recovery and accessibility, and repeat the checks for multiple instances, external links and offline behavior in a release environment. Windows and Linux need their own packaging, data paths, process handling and verification. Review the desktop security boundary and bundled dependency licenses. The agent's optional image tool needs a packaged compatible renderer or a desktop rendering bridge.

## Desktop development

Run `pnpm dev:desktop` to start the Electron window with Vite hot reload. It uses the same default data directory as `pnpm dev`. Set `PASO_DATA_DIR` to override it. For an isolated run use, for example, `PASO_DATA_DIR=/tmp/paso-desktop-check/projects pnpm dev:desktop`. This also puts Electron's profile in the temporary parent directory. The service and Vite use separate free loopback ports, leaving 3001 and 5173 available. Server source changes rebuild the service and restart the window. Closing the window stops Vite and the service, including agent processes.

The development window retains the sandbox, preload token bridge, permission denial, external link handling and network request restrictions of the packaged app. It handles the shared preload's native folder picker with the same main-frame and origin checks as the packaged app. Vite serves the page and proxies API traffic to the embedded service. Its local WebSocket and development scripts are allowed for HMR, and Vite's development content does not have the packaged app's strict content security policy. The token is not injected into the development HTML. These exceptions apply only to the development entry point.
