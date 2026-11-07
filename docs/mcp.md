# Paso board MCP server

`@paso/mcp` exposes the same board tools to a stdio MCP client. It uses the
official TypeScript MCP SDK. All project reads and writes use the authenticated
local service API. The MCP process never opens project folders. It does not
launch a harness, change harness permissions, make restore points, or expose
shell commands or general file access.

## Build and start

Use the repository's Node and pnpm versions. From the repository root, run
`pnpm install` and `pnpm build`. Start the compiled entry point with
`node /absolute/path/to/paso/apps/mcp/dist/cli.js`. The working directory does
not matter. Keep the workspace dependencies installed alongside the build.

The local Paso service must already be running. A trusted parent must supply
its current session token, as described in [server-api.md](server-api.md).
MCP does not discover or print a token. The normal `pnpm dev` launcher keeps
its token private to its children, so a separate shell does not automatically
inherit it. An embedding host can use `startServer(...)` and give its returned
URL and token to both the app and the MCP child.

| Variable | Meaning |
| --- | --- |
| `PASO_SERVICE_URL` | HTTP origin of the service. Default `http://127.0.0.1:3001`. Only `127.0.0.1` and `localhost` are allowed. No path, credentials, query or fragment. |
| `PASO_SESSION_TOKEN` | Required current service token, 32 to 256 base64url characters. Obtain it from the trusted host, not an agent prompt. |
| `PASO_MCP_BROWSER_EXECUTABLE` | Optional absolute path to an installed Chromium executable. Enables images. No browser is downloaded or searched for. |

Missing or malformed token configuration exits with status 1 and an error on
stderr. A well-formed but wrong token produces `UNAUTHORIZED` on service calls.
Connection failures produce `SERVICE_UNAVAILABLE`. Stdout is only MCP protocol
traffic. The service token is not logged, saved to project files, included in
browser content, or exposed as a tool argument.

## Configure a harness

Give any MCP-capable harness a **stdio** server definition with these values.
Use an absolute entry-point path and pass the session environment from its
trusted parent. Do not put a token in repository configuration or a prompt.

```json
{
  "command": "node",
  "args": ["/absolute/path/to/paso/apps/mcp/dist/cli.js"],
  "env": {
    "PASO_SERVICE_URL": "<local service origin from the host>",
    "PASO_SESSION_TOKEN": "<current session token from the host>"
  }
}
```

This is a transport definition, not a complete provider-specific config file.
Claude Code and `agy` hosts must place it in their supported MCP configuration
or pass it through their launcher. Paso's own Claude Code launcher, with its
board-only permissions, is described in [server-api.md](server-api.md#agent-sessions).
The Codex and `agy` launchers and their board-only policies belong to AG-06 and AG-07.

For Codex, a host can use the documented MCP server configuration in its
private or temporary config. Inherit the two values instead of storing them.

```toml
[mcp_servers.paso]
command = "node"
args = ["/absolute/path/to/paso/apps/mcp/dist/cli.js"]
env_vars = ["PASO_SERVICE_URL", "PASO_SESSION_TOKEN"]
```

Add `PASO_MCP_BROWSER_EXECUTABLE` to `env_vars` if the host supplies one.
The reference is the [official Codex MCP documentation](https://developers.openai.com/codex/mcp).
These tools do not restrict other abilities of a harness. Its launcher must
apply the intended board-only policy separately. No real model session is
needed to run the protocol tests below.

## Tools

Each tool has a strict JSON schema. Unknown input fields are errors.
IDs for projects, scenes and steps are service IDs, not names or paths.

| Tool | Input and result |
| --- | --- |
| `list_projects` | No arguments. Lists existing projects, revisions and errors for invalid projects. |
| `read_project` | `projectId`. Returns its document and ordered scene documents with revisions. |
| `read_scene` | `projectId`, `sceneId`. Returns the scene and ordered step IDs, titles, counts and revisions. |
| `read_step` | `projectId`, `sceneId`, `stepId`. Returns the revision and a simple layout, including labels, connections and potential overlaps. |
| `create_scene` | `projectId`, `name`, optional `id`. Appends an empty scene and returns its service envelope. |
| `create_step` | `projectId`, `sceneId`, optional `id`, `title`, `speakerNotes`. Appends an empty step and returns its envelope. |
| `duplicate_step` | Step target, `revision`, optional new step `id`. Appends a full independent copy in the same scene, keeping element IDs, assets and unknown data. |
| `add_elements` | Step target, `revision`, `elements`. Adds one batch and returns the saved revision and layout. |
| `update_elements` | Step target, `revision`, `elements` containing patches by `id`. Returns the saved revision and layout. |
| `delete_elements` | Step target, `revision`, `ids`. Tombstones elements in this step. Deleting a shape also deletes bound labels and connected arrows. Cleans reciprocal bindings. |
| `get_step_image` | Step target. Returns an MCP `image/png` content block and its source revision, or `isError` with a useful layout fallback. |

There are deliberately no tools to create or delete a project, delete a scene
or step, access harness credentials, or read or write arbitrary files. Project
creation stays with the user or host. The MCP token is a full local-service
credential, not a service-enforced tool-specific capability. A host must not
make that credential available to an untrusted model through another tool.

### Drawing format

Coordinates are canvas pixels. Positive x goes right and positive y goes down.
`x` and `y` are the top-left, not the center. Negative coordinates are valid.
Position limits are ±1,000,000. Dimensions are positive and at most 20,000.
Font size is 12 to 96. A batch contains at most 200 elements or patches.

- Shapes use `type` of `rectangle`, `ellipse` or `diamond`, plus `id`, `x`, `y`.
  Optional `width` and `height` are **minimum** sizes, defaulting to 180 and 90.
  Optional `label` is bound text. Labels can grow a shape to fit.
- Text uses `type` of `text`, `id`, `x`, `y`, `text` and optional `fontSize`.
  Its measured dimensions are automatic. The default font size is 24.
- Arrows use `type` of `arrow`, `id`, `fromId` and `toId`. They are straight,
  with a single end arrowhead and an eight-pixel gap. Both ends bind the shape
  borders on a center-to-center line. Connected shapes must have different
  centers. Arrows can refer to shapes later in the same add batch.
- Optional style fields are `strokeColor`, `strokeWidth` and `opacity`.
  Shapes and text also accept `backgroundColor`. Colors use `#rrggbb`, with
  `transparent` also allowed for backgrounds. Stroke width is 1 to 8. Opacity
  is an integer from 0 to 100. New elements use solid fills and roughness 0.
- Text has a 4,000-character limit. Use explicit `\n` line breaks. There is no
  automatic wrapping. Text is normalized to NFC, LF line endings and eight
  spaces per tab. Unsupported glyphs and control characters are rejected,
  rather than measured with an unknown fallback font.

For example, pass this array to `add_elements` with the step target and its
current revision.

```json
[
  { "type": "rectangle", "id": "input", "x": 80, "y": 120, "label": "Información\nEntrada" },
  { "type": "diamond", "id": "check", "x": 440, "y": 90, "label": "¿Es válido?" },
  { "type": "arrow", "id": "input-check", "fromId": "input", "toId": "check" }
]
```

Then duplicate that step and add the next part of the explanation to the copy.
Update with an object such as `{ "id": "input", "x": 120, "label": "Nueva entrada" }`.
Use `label: null` to remove a shape label. Patch the parent shape, not the
generated bound-text ID. Font size changes also remeasure the text.

Element IDs cannot be reused while their tombstones exist. Unspecified fields
and unknown nested fields on existing elements are preserved. Each affected
existing element increments `version` once per batch, receives a new
`versionNonce` and advances `updated`. Unchanged elements retain their metadata.
Agents never supply seeds, indexes, nonces, bindings or other Excalidraw internals.

The editing subset is axis-aligned, unlocked, ungrouped and unframed. Moving or
resizing a shape updates its label and straight center-bound arrows. A complex
arrow, a rotated shape or another unsupported edit returns a clear error and
makes no write. Existing unsupported elements remain in the document. Use Paso
for edits outside this subset. No element update propagates to other steps.

### Revisions and errors

Use the exact unquoted `revision` from a fresh read or successful write.
Creation appends safely under the service's project lock and needs no parent
revision. Duplication checks the source step revision. Element writes check
the requested revision before conversion, then send it in `If-Match` when
replacing the step. A concurrent change during conversion is also rejected.

`REVISION_CONFLICT` means nothing was written by this tool call. Read the step
again and reconsider the edit. There are no automatic write retries. After an
uncertain connection failure, inspect current state before retrying creation
or a write. Each call has one atomic step write, not a scene-wide transaction.
Tool failures use MCP `isError` and a descriptive text result.

## Browser and font decisions

### Full elements without a browser

The installed Excalidraw 0.18.1 package is not a Node renderer. A direct Node
import fails on browser-oriented dependency resolution. Its conversion and
text-measurement paths use a DOM canvas. Adding a DOM stub would not provide
real font metrics or a reliable exporter.

The MCP adapter therefore constructs the supported full elements in Node.
`fontkit` reads the **same bundled Liberation Sans WOFF2** that Excalidraw uses
for font family 9. It measures glyph advance widths, not character counts.
Shapes receive extra label padding, with the ellipse and diamond inner-area
rules accounted for. Bindings are reciprocal. Fractional drawing indexes,
seeds and metadata are internal to the adapter.

This lets creation and editing work offline with no app window or browser.
It uses one predictable font instead of depending on OS fonts. The tradeoff is
an explicit glyph set and a limited editing subset. Changes to Excalidraw or
its bundled font require rerunning real-browser checks, not just unit tests.

### Images without an app window

The optional image path uses installed Chromium and the **real bundled
Excalidraw exporter**, not an approximate SVG or Node canvas renderer. It starts
a fresh headless browser and private temporary profile for each image. A small
loopback server serves only compiled renderer assets and a random, short-lived
snapshot URL. Browser control uses Chromium's private debugging pipe, not a
network debugging port. The Paso session token never enters the browser.
Images and fonts load locally. A content security policy blocks external
resources. Project assets are fetched only through the authenticated API.
The longest PNG side is at most 2048 pixels. A render has a 30-second browser
deadline. The browser, local server and temporary profile are closed afterward.

Compared with the alternatives, a connected Paso window would avoid a second
browser but would depend on an open window and a new render-request bridge.
A custom Node renderer would diverge on fonts, rough strokes, bindings, images
and future element types. Headless Chromium has a larger footprint, but uses
the same exporter and works with no app window.

No browser is bundled or downloaded by this task. A packaged desktop host must
either supply a compatible installed Chromium executable, add an embedded
webview rendering bridge in a later task, or keep the fallback. An Electron or
Tauri packaging test has not been performed. This server does not assume that
an Electron executable supports this Chromium sidecar configuration.

Without Chromium, or if rendering fails, `get_step_image` returns
`IMAGE_UNAVAILABLE` and the current step layout. The agent can inspect positions,
dimensions, labels, connections and shape bounding-box intersections. Those
intersections are a warning, not proof of visual overlap or absence of clipping.
For a visual check, open the step in Paso. The fallback is never passed off as
an image.

## Verification commands

`pnpm test` builds the compiled MCP and service before running protocol tests.
The test client starts both from their compiled entry points, uses real stdio
MCP messages and a real temporary service data directory, and closes them.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
PASO_MCP_TEST_BROWSER="/absolute/path/to/Chromium" pnpm exec vitest run apps/mcp/src/protocol.test.ts
```

The last command additionally tests an actual PNG without an app window. With
no test-browser variable, that one optional browser-dependent test is skipped.
Real app checks must also cover both themes, font dimensions, manual shape
movement with bound arrows, saving, reloading and unknown-field retention.
Keep Playwright used for those checks in a temporary directory. It is not a
repository dependency. Do not commit screenshots or a verification report.
