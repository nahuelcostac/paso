# Local data service

Run `pnpm install` and `pnpm dev` from the repository root. Open
<http://127.0.0.1:5173>. The API listens on `127.0.0.1:3001`.
The web app lists and edits projects through this API.

For the compiled service, run `pnpm build`, then
`node apps/server/dist/cli.js`. Set `PASO_DATA_DIR` to a directory containing
project folders. The default is `~/Library/Application Support/Paso/projects`
on macOS, `%LOCALAPPDATA%/Paso/projects` on Windows, or
`${XDG_DATA_HOME:-~/.local/share}/paso/projects` on Linux. `PASO_PORT` defaults
to 3001. Run `node scripts/server-smoke.mjs` after building to verify the CLI
from its `dist` directory against temporary real files.

## Embedding and authentication

```ts
import { startServer } from '@paso/server';

const service = await startServer({ dataDir, port: 0 });
// Deliver service.sessionToken to the trusted client through its host.
// service.url and service.port contain the selected loopback endpoint.
await service.close();
```

`startServer` is asynchronous. Each instance generates a random 256-bit token.
An embedder can supply `sessionToken`, with 32 to 256 base64url characters.
The CLI accepts `PASO_SESSION_TOKEN` when a trusted parent supplies the token.
A standalone CLI with no supplied token generates one that it does not expose.
It is intended for use through an embedder or a parent process.

Every HTTP request, including health checks and unknown routes, requires
`Authorization: Bearer <token>`. Every WebSocket handshake requires the
subprotocols `paso` and `paso-token.<token>`. The server selects only `paso`.
Tokens in URLs, cookies and request bodies do not authenticate requests.
Tokens are never logged or persisted by Paso.

`Host` must be exactly `127.0.0.1:<actual-port>` or `localhost:<actual-port>`.
If present, `Origin` must match one of those HTTP origins or an exact origin
supplied in `allowedOrigins`. The CLI accepts comma-separated
`PASO_ALLOWED_ORIGINS`. A missing Origin permits native clients. `null`, wildcard
origins and unrelated hosts are rejected. The server emits no CORS grants.
Cross-origin preflights do not bypass authentication. A desktop shell should
use a same-origin proxy or a trusted preload bridge for HTTP and WebSocket
access, and pass the per-run token through trusted window initialization.
It must not put the token in a packaged bundle or a navigation URL.

`pnpm dev` builds shared code, generates a fresh token in the launcher and
passes it through the environment to the server and Vite. Vite inserts it into
a `paso-session-token` meta tag in development HTML. The browser sends it in the
health request. Vite binds to loopback on port 5173, rejects unexpected Host
and Origin values, disables CORS, and proxies `/api` with the server Host.
The production build contains no token. A desktop host must supply the meta
tag or adapt the client to its trusted initialization channel. Starting the
web package alone does not supply a session. Restart root `pnpm dev` to rotate it.

## Workspaces

A workspace is a folder on this computer that holds project folders. The data
directory (`PASO_DATA_DIR`) is the default workspace, «Mis diagramas». It is
always listed and cannot be removed. The person can add other folders.

The service has one open workspace at a time. Every project route, the event
stream, the agents and the MCP tools work in that folder, so a client never
names a workspace in a project route. Opening another workspace closes the
current folder's watcher, opens the new one, and sends
`{ type: "workspaces", activeId }` on the event stream. A client then reads
its projects again. The service refuses to switch with 409 `AGENT_RUNNING`
while an agent works.

The list lives in `workspaces.json` next to the data directory (option
`workspacesPath`, variable `PASO_WORKSPACES_PATH`), never inside a workspace.
Removing a workspace takes it off the list and deletes nothing. The open
workspace is restored on the next start when its folder still exists and the
list was written for the same data directory; otherwise the service starts in
the default one. A workspace whose folder is gone is listed with
`available: false`, and opening it fails with 422 `WORKSPACE_UNAVAILABLE`.
It is never created again silently.

A folder can be added when it exists and is not the home folder, a disk's root,
another workspace, inside one or containing one, or one of Paso's own folders
(the app data folder, the restore points and the agents' folder). Restore
points of added workspaces are kept in `workspaces/<id>/runs` next to the
default restore points, so Paso writes nothing into the person's folders
except their projects.

| Method | Route | Input or result |
| --- | --- | --- |
| GET | `/workspaces` | `{ activeId, workspaces: [{ id, name, path, default, available }] }` |
| POST | `/workspaces` | `{ path, name? }`, adds an existing folder, returns 201 with the workspace. It does not open it |
| PUT | `/workspaces/active` | `{ id }`, opens that workspace, returns the list |
| DELETE | `/workspaces/:w` | Takes it off the list; the default workspace opens if it was open |
| POST | `/workspaces/:w/reveal` | Shows the folder in the system's file manager |
| GET | `/folders?path=` | The folder explorer: `{ path, parent, home, crumbs, folders: [{ name, path }], projects }` |
| POST | `/folders` | `{ parent, name }`, creates a folder, returns 201 with `{ path }` |

The folder explorer lists folder names only: no files, nothing they contain,
no hidden folders, and no links. `projects` counts the subfolders that hold a
`project.json`. Without `path` it starts in the home folder. `crumbs` is the
way down to the folder, from the home folder when it is inside it.

## Routes

All routes start with `/api`. Document responses use
`{ document, revision }` and `ETag: "<revision>"`. A revision is the SHA-256 hash
of the exact file bytes. It includes direct edits and formatting changes.
Document bodies never contain revision fields.

| Method | Route | Input or result |
| --- | --- | --- |
| GET | `/health` | `{ status: "ok" }` |
| GET | `/projects` | `{ projects: [{ id, document, revision } or { id, error }] }` |
| POST | `/projects` | `{ name, id?, icon? }`, returns 201 |
| GET, PATCH, DELETE | `/projects/:p` | Read, change with `{ name?, icon? }`, or delete recursively |
| GET, POST, PUT | `/projects/:p/scenes` | List `{ scenes: [...] }`, create `{ name, id? }`, or reorder `{ ids }` |
| GET, PATCH, DELETE | `/projects/:p/scenes/:s` | Read, rename with `{ name }`, or delete recursively |
| GET, POST, PUT | `/projects/:p/scenes/:s/steps` | List `{ steps: [...] }`, create a snapshot, or reorder `{ ids }` |
| GET, PUT, DELETE | `/projects/:p/scenes/:s/steps/:t` | Read, replace a complete versioned step, or delete |
| POST | `/projects/:p/scenes/:s/steps/:t/duplicate` | `{ id? }`, returns 201 with the copy appended |
| GET, PUT, DELETE | `/projects/:p/assets/:fileId.:ext` | Read binary bytes, upload immutable bytes, or delete an unused asset |
| GET, POST | `/projects/:p/runs` | List `{ runs: [...] }` or start a run `{ id?, label? }`, returns 201 |
| GET | `/projects/:p/runs/:r` | Read `{ run }` summary and conflict warnings |
| POST | `/projects/:p/runs/:r/finish` | Finish a running run, returns `{ run }` |
| GET, POST | `/projects/:p/runs/:r/undo` | Preview `{ plan }` without modifying files, or execute undo `{ confirm, force? }` |
| WS | `/events` | Global stream for all projects in this data directory |

JSON requests need `Content-Type: application/json`. A step creation body may
contain `id`, `title`, `speakerNotes`, `elements`, `appState` and `files`.
Omitted content uses shared creation defaults. Step replacement requires the
complete step document, including `schemaVersion`. Its ID cannot change.
Duplication retains element IDs, asset references and unknown element fields.
A project body has an optional `icon`, the name of a Lucide icon (see the data
format). `POST /projects` accepts it. `PATCH /projects/:p` takes a `name`, an
`icon`, or both, and needs at least one; `{ "icon": null }` removes the icon. A name
that is not the shape of an icon returns 400. The service does not know which icons
exist. Scenes are renamed with `{ name }` only.
Lists follow parent order. Reordering must contain exactly the current children.
It changes the parent order list and the project's `updatedAt` timestamp.

All updates, deletes, reorders and duplications require `If-Match` with the
quoted revision of the target document. Scene reordering targets the project;
step reordering targets the scene. Creation appends under the project lock and
does not require a parent revision. Every content mutation advances project
`updatedAt`. A stale revision returns 409. A missing revision returns 428.
Read fresh state before retrying a conflict. Document IDs are project-wide.

Upload assets before saving a step that refers to them. The shared manifest
schema validates paths and metadata; the server also checks binary existence.
Upload uses raw bytes and an ID plus a lowercase extension. The same asset ID
cannot receive different bytes or an alternate extension. Repeating an upload
of identical bytes is safe. Deleting an asset requires its `If-Match` ETag and
no manifest references, including references in deleted elements or unused
manifest entries. Binary reads use `application/octet-stream`, `attachment`
and `nosniff`; the client reconstructs the MIME type from the step manifest.

## Events and external edits

Connect before fetching initial state. Wait for `{ type: "ready" }`, then read
state and reconcile later events by revision. Reconnect and refetch after a
socket disconnect. There is no replay log.

```json
{
  "type": "updated",
  "kind": "step",
  "projectId": "project-id",
  "sceneId": "scene-id",
  "id": "step-id",
  "revision": "sha256-of-new-file-bytes",
  "previousRevision": "sha256-of-previous-file-bytes"
}
```

Types are `created`, `updated`, `deleted` and `reordered`. Kinds are `project`,
`scene`, `step` and `asset`. Asset IDs in events include their extension.
Deletes set `revision` to null and retain `previousRevision`. A changed order
list emits `reordered`, including child creation and deletion. Writes can emit
several events because parent documents also change. Invalid external documents
emit `project-error` with a message. The normal read or list reports full tree
validation errors, such as an order list that refers to a missing child.

A recursive filesystem watcher and a one-second fallback scan compare exact
file hashes. API writes use the same comparison under the same project queue,
so they do not produce duplicate watcher events. Hidden temporary files,
unknown filenames and invalid path IDs are ignored. Recognized documents go
through shared parsing; a project read validates the whole discovered tree,
filename IDs and asset existence. A corrupt or newer-version project appears
as an individual error in the project list. Repair such files on disk.

Writes use a temporary file in the destination directory, flush it, then
rename it. Requests and watcher scans serialize per project. This is atomic
per file, not a multi-file transaction or a cross-process lock. Run one service
per data directory. External tools may expose intermediate states during a
multi-file edit; clients must refetch after subsequent events. Coalesced
filesystem notifications report the latest observed revision and do not form
an audit trail of every transient file write. Symbolic links below the real
data root are rejected. This does not isolate the service from a malicious
local process that can replace directories while operations are in flight.

## Errors and limits

Errors use `{ error: { code, message } }`. No internal filesystem path or token
is included in unexpected-error responses. Validation messages can include
shared-schema issue details.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, shared-schema validation, ID or asset path |
| 401 | Missing or wrong session token |
| 403 | Unexpected Host, Origin or duplicate security header |
| 404 | Route, project, scene, step or asset not found |
| 405 | Unsupported method |
| 409 | Stale revision, existing ID or path collision, immutable asset or asset still in use |
| 413 | Body too large |
| 415 | JSON Content-Type required |
| 422 | Invalid on-disk project, unsafe link or missing referenced asset |
| 428 | If-Match required |
| 500 | Unexpected local service failure |

Default limits are 10 MiB for JSON and 50 MiB for one binary upload. Embedders
can set `maxJsonBytes`, `maxAssetBytes` and `pollIntervalMs`. Slow WebSocket
clients are disconnected above 1 MiB of pending output. Requests time out
after 30 seconds. Headers have a 10-second timeout.

## Agent harnesses

All harness routes require the session token. `GET /api/harnesses/detect`
returns `{ harnesses: [...] }` for Claude Code (`claude`), Codex (`codex`)
and Antigravity (`agy`). Each entry has `id`, `found`, `path`, `version` and
`session` (`signed_in`, `signed_out` or `unknown`). `path` and `version` can
be null. A missing or signed-out harness also has a Spanish `message`.
Detection runs asynchronous, time-limited commands and never starts a session.
Claude provides `auth status --json`; Codex provides `login status`; agy has
no status command in its help. A failed or unrecognised status is `unknown`.

`GET /api/harnesses` returns the added harnesses with fresh detection results.
`POST /api/harnesses` with `{ "id": "claude" }` adds one and returns its
current detection with status 201. Adding an already added ID is idempotent.
A missing executable returns 422; an unknown ID returns 400.
`DELETE /api/harnesses/:id` removes it and returns 204, even if absent.
Only IDs are persisted. The default file is `harnesses.json` next to the
projects directory, outside project listings. Embedders can set
`harnessRegistryPath`; the CLI accepts `PASO_HARNESS_REGISTRY_PATH`. The file
must be outside `dataDir`. Writes use a flushed temporary file and rename.
Run one service per registry file. Detection searches PATH, common install
locations and the login shell, so a desktop host need not inherit a shell PATH.

## Agent sessions

A session lets an agent run on the user's own harness and edit a project
through the Paso board tools ([mcp.md](mcp.md)). Claude Code (`claude`) is
supported, as is Codex (`codex`). `agy` (AG-07) will use the same interface;
until then it returns 422 `HARNESS_NOT_SUPPORTED`. The harness must be
installed and signed in on this machine with the user's own login. Paso never
stores API keys, and `ANTHROPIC_*`, `CLAUDE_CODE_*` and other variables of the
service's environment are not handed to the harness.

All routes need the session token. Errors and messages are in Spanish.

| Method | Route | Input or result |
| --- | --- | --- |
| POST | `/agent/sessions` | `{ harness, projectId, sceneId?, model? }`, returns 201 with the session. The project and scene must exist. |
| GET | `/agent/sessions` | `{ sessions }`, newest first. `?projectId=` filters. |
| GET, DELETE | `/agent/sessions/:id` | Read, or cancel and forget (204). |
| POST | `/agent/sessions/:id/messages` | `{ text }` (1 to 32,000 characters). Returns 202 `{ runId }`; the answer arrives as events. |
| POST | `/agent/sessions/:id/cancel` | `{ cancelled }`. Stops the run and its whole process tree. Idempotent. |
| POST | `/agent/sessions/:id/resume` | Reopens a stored session, for example after a restart. 409 if it never reached the harness. Sending resumes it too. |
| GET | `/agent/sessions/:id/events?after=N` | `{ events, next }`. The last 500 events of the session, without `text_delta` (each `text` repeats them), for reconnecting clients. |

A session is `{ id, harness, projectId, sceneId?, model?, state, resumable,
createdAt, updatedAt }` with `state` of `idle` or `running`. `model` is passed
to the harness only if the client set it; otherwise the harness uses its own
default. A message while the session is running returns 409 `SESSION_BUSY`.

A **run** is one message and the agent's whole answer to it. It is the unit
that restore points attach to (see below).

### Events

Events are broadcast on the existing `/api/events` WebSocket and also kept for
`GET .../events`:

```json
{ "type": "agent", "sessionId": "…", "runId": "…", "seq": 7, "at": "2026-11-07T18:30:45.000Z",
  "event": { "type": "tool_use", "id": "t1", "tool": "add_elements", "readOnly": false,
             "target": { "projectId": "p", "sceneId": "s", "stepId": "st" } } }
```

`seq` increases by one per session, so a gap in the replay is only skipped deltas. `event` is one of these. Nothing in them
is specific to one harness, and tool arguments, tool results and raw harness
output are never forwarded.

| `event.type` | Fields |
| --- | --- |
| `started` | The run was accepted (added by Paso). |
| `session` | `resumeToken` (opaque, kept by Paso for resume), `model?`. |
| `text_delta` | `text`, an increment of the assistant's answer. |
| `text` | `text`, a complete assistant text block. Repeats the deltas before it. |
| `tool_use` | `id`, `tool` (board tool name, such as `add_elements`), `readOnly`, `target?` (`projectId`, `sceneId`, `stepId` when the call names them). |
| `tool_result` | `id`, `ok`. |
| `finished` | `reason`: `completed` or `cancelled`. |
| `failed` | `code` and a Spanish `message`. |

Every run ends with exactly one `finished` or `failed`, and it is sent only
after the harness process tree is gone, so the next message can start at once.
Codes: `not_installed`, `signed_out`, `quota`, `model_unavailable`,
`unsupported_version`, `unsafe_configuration`, `board_unavailable`, `timeout`,
`crashed`, `protocol`, `blocked`, `harness_error`. The message never contains
harness text, stderr or paths.

### Limits

One run per project at a time (409 `PROJECT_BUSY`) and four in the service
(409 `TOO_MANY_RUNS`). Two agents editing one project would race on step
revisions and could not be undone as separate runs. Sessions that are not
running hold no process. A run fails with `timeout` after 120 s without output
and is stopped after 20 minutes. At most 200 sessions are remembered; the
oldest idle ones are dropped first.

### What the agent can do

By default the agent has **only the Paso board tools**: no shell, no file
editing or reading, no web, no sub-agents, no skills. For Claude Code every run
passes (exact arguments are asserted in `agent.test.ts`):

| Argument | Why |
| --- | --- |
| `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | Streaming protocol. The user's text goes to stdin as message content, never on the command line. |
| `--tools ""` | The built-in tool set is an allow-list and it is empty. A built-in tool added by a future version is not enabled. |
| `--strict-mcp-config --mcp-config <json>` | The only MCP server is `paso`. User, project and account (claude.ai) servers are ignored. |
| `--allowedTools mcp__paso__*` | Only the board tools are pre-approved. |
| `--disallowedTools Bash Edit Write Read …` | Second layer: built-ins denied by name too. |
| `--permission-mode dontAsk --permission-prompts none` | Anything not pre-approved is denied and nobody is asked. `bypassPermissions` and `--dangerously-skip-permissions` are never used. |
| `--setting-sources ""` plus `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | No user, project or local settings, hooks or CLAUDE.md files. |
| `--disable-slash-commands` | Text starting with `/` is not a command or skill. |
| `--append-system-prompt` | Names the project and scene (service IDs) and says only board tools exist. |
| `--model` / `--resume` | Only if the session set a model / has a resume token. |

The first message of the stream is checked as well: if Claude reports a
permission mode other than `dontAsk`, any tool that is not `mcp__paso__*`, or
an MCP server other than `paso`, Paso stops the process and the run fails with
`unsafe_configuration`. A tool call outside the board tools does the same. A
board server that did not connect fails with `board_unavailable`.

The harness runs in a dedicated, empty directory (`agent-workspace` next to the
projects directory, mode 0700), never the repository, the home folder or the
data directory. A run refuses to start if it is not empty. Its environment is a
whitelist (PATH, HOME, USER, LOGNAME, SHELL, locale, temp, proxy and
certificate variables, `CLAUDE_CONFIG_DIR`, and on Windows the system folders),
so the service behaves the same when started from another agent or a normal
terminal. macOS needs `USER` to find the keychain login.

The service token reaches the board tools through the environment only: the
MCP definition holds `${PASO_SESSION_TOKEN}`, which Claude Code expands for the
MCP child. No argument and no file holds it. It is in the environment of the
harness and the MCP process, readable by the same user only. Harness
detection (`/harnesses/detect`) uses the same reduced environment, so
"signed in" means what a session will see.

What still reaches a session, by design or because the CLI cannot turn it off:
the built-in plugins and sub-agent types Claude Code lists at start (they
cannot act without tools); administrator-managed policy settings, which the CLI
always applies; and the user's Claude Code **transcripts**. Resume needs them,
so Claude Code saves each session (prompts, answers and board data the agent
read) under `~/.claude/projects/<working directory>` as it does for any run.
Paso does not read them and does not copy messages anywhere: its own index
(`agent-sessions.json`, mode 0600) holds only IDs, project, scene, model and the
resume token.

Paso does not log prompts, answers, tokens or harness output.

### Codex policy and protocol

Codex uses `codex app-server --listen stdio:// --strict-config`, with one process per turn.
Paso sends `initialize`, `thread/start` or `thread/resume`, then `turn/start`.
Assistant deltas and complete messages use the common events above. Cancellation
stops both the app-server group and the separate board MCP group, and waits for
them before publishing the terminal event. Resume works after restarting Paso.

`exec --json` is simpler and has useful `--ignore-user-config` and
`--ignore-rules` flags in the installed CLI. App-server was selected because
its dynamic-tool requests let Paso validate every call **before** forwarding
it to the board. Its richer protocol also supplies text deltas and effective
sandbox and approval settings. The trade-off is an experimental protocol and
more adapter code. The common `HarnessAdapter` interface is unchanged.

This integration currently accepts **Codex CLI 0.166.0 only**. An unverified
version fails with `unsupported_version` before a turn is submitted. Upgrade
the adapter and rerun the real checks before accepting another version. Flags
and schemas were checked using that executable's `--help` and
`app-server generate-json-schema --experimental`.

The controls act together.

- A private `codex-home` directory beside the neutral workspace becomes
  `CODEX_HOME`. It contains no global config, plugins, MCP definitions or
  AGENTS.md. Unexpected config or instruction files cause
  `unsafe_configuration`. `project_doc_max_bytes=0` also prevents project
  instructions from loading. Skills, hooks, memories, plugins, apps, shell,
  browser tools, web search, code execution and delegation are disabled.
- The home contains only a symlink to the person's existing CLI `auth.json`
  for authentication. Paso never reads or copies its contents and does not
  accept API keys. `forced_login_method="chatgpt"` requires the person's
  subscription login. The CLI owns authentication and refresh. Login lookup uses
  the original `CODEX_HOME` environment value, or `~/.codex`. A login held only
  in a keychain under another home has not been verified. Use the CLI's file
  login for this integration. Windows symlink permissions have not been tested.
- A Paso-owned model catalog removes shell tools, `apply_patch`, native code
  execution, model-specified extension tools and multi-agent mode. Feature
  flags alone are insufficient in this CLI because provider model metadata
  can also enable tools. The catalog uses the requested model without fallback.
  The default is `gpt-6.1-sol`; the API accepts another model through `model`.
- `approval_policy="never"`, `sandbox_mode="read-only"`, disabled web search
  and `environments: []` apply to every turn. In 0.166.0, `thread/resume` can
  restore the neutral local environment. Paso clears it in `turn/start`
  before submitting user content. Unexpected environments, instruction sources,
  a writable sandbox or another approval policy stop the run.
- Codex has **no configured MCP servers**. Paso connects the compiled
  `apps/mcp` server itself and exposes exactly its thirteen board tools as
  app-server dynamic tools. It checks the tool list against a fixed allow-list.
  Calls with another tool, namespace or thread, duplicate call IDs, native tool
  events, approval requests and unexpected MCP servers stop the run with
  `unsafe_configuration`. No approval is granted and no UI prompt is opened.
- Only the MCP process receives `PASO_SESSION_TOKEN`, through its environment.
  Codex receives neither the token nor a file or argument that holds it. The
  existing MCP client sets `X-Paso-Actor: mcp`, so edits appear live and belong
  to the turn's existing restore point.

The catalog and CLI-owned transcripts live under `codex-home`, outside the
project directory. The CLI persists prompts, answers and board data there for
resume. Paso's session index still contains only IDs and resume tokens.
Administrator-managed CLI requirements can still apply. Paso checks the
reported effective policy and fails closed if it conflicts with this policy.

The agent picker enables Codex with the same add, send, stop and undo controls
as Claude Code. Adding it uses the person's local login and quota.

### Processes

The harness runs without a shell, as an argument array, in its own process
group. Cancelling, a timeout, an unsafe configuration or closing the service
sends SIGTERM to the group, then SIGKILL after 1.5 s, so Claude, its MCP
server and anything they started end together (`taskkill /T /F` on Windows,
which has not been tested). `close()` waits for them; the CLI handles SIGINT and
SIGTERM, and an exit handler kills the groups if the service dies abnormally.
If the service is killed outright (SIGKILL), a running harness cannot be
stopped by anyone: it finishes its current turn on its own, within seconds to
minutes, and its board tools stop working because the service and token are
gone.

A turn is one process: the next message starts `claude --resume <token>`. A
crash, hang, signed-out account or exhausted quota ends the run with `failed`
and leaves the session usable.

### Run hooks

`SessionManager` has one place where a run starts and ends. `startServer`
automatically connects `beforeRun` and `afterRun` to `RunStore` (starting a
restore point with `id: runId` and `label: "${harness}:${sessionId}"` before the
turn and finishing it when the turn ends), and also calls any custom hooks
passed in `startServer({ agent: { hooks } })`:

```ts
hooks: {
  beforeRun({ sessionId, runId, harness, projectId, sceneId }) {}, // throw to refuse the run (`blocked`)
  afterRun(context, { status: 'completed' | 'cancelled' | 'failed', failure? }) {}, // errors ignored
}
```

`beforeRun` runs after the run is accepted and before anything starts, so the
restore point is created there. `afterRun` runs after the terminal event and
before the session can accept another message, so the restore point is closed
before the session becomes `idle`.

### Configuration

`startServer({ agent })` accepts `workDir`, `sessionsPath` (outside `dataDir`),
`mcp` (`entry`, or `command` and `args` for a packaged host; `browserExecutable`
enables step images), `hooks`, `maxRunsPerProject`, `maxRuns`, `idleTimeoutMs`
and `maxRunMs`. The default MCP server is the compiled
`apps/mcp/dist/cli.js`, started with the service's own Node (`pnpm build`
first). The CLI reads `PASO_AGENT_WORKDIR`, `PASO_AGENT_SESSIONS_PATH`,
`PASO_MCP_ENTRY` and `PASO_MCP_BROWSER_EXECUTABLE`.

### Adding another harness

An adapter implements `HarnessAdapter.run(request, signal)` in
`apps/server/src/agent/types.ts`: start one process for one turn, translate its
output into the events above, end with exactly one terminal event, and use
`harnessEnvironment` and `startProcess` for the environment and process tree.
Codex implements this interface through app-server and its board bridge. The
`agy` CLI provides `agy -p --input-format stream-json --output-format
stream-json --conversation <id>`. These commands alone do not establish a
board-only policy. Each adapter must establish and verify its own policy
before enabling the harness.

The installed `agy` 1.5.3 was investigated for AG-07. Its print-mode init
event listed built-in shell, file and web tools even with `--sandbox` and
`--disable-slash-commands`; `--mode plan` had no effect with slash commands
disabled. Its help does not document an empty built-in tool allow-list or a
strict MCP configuration equivalent to Claude's. ACP supports streaming,
resume, cancellation and client-provided MCP servers, but its session creation
response did not provide a tool inventory or prove that global configuration
and built-in tools were excluded. Neither route has yet been shown to satisfy
Paso's board-only policy. Keep `agy` unsupported until those restrictions can
be enforced and checked before any user prompt runs. A print-mode quota error
observed during investigation included `RESOURCE_EXHAUSTED`, HTTP 429 and
`Individual quota reached`; a future adapter must map it to `quota`.

### Tests

`pnpm test` runs the session tests against a fake `claude`
(`agent/testing/fake-claude.mjs`), so they pass without Claude Code: event
normalization, split and malformed output, cancel, crash, hang, resume, exact
arguments, secrets absent from arguments and logs, and process-tree cleanup.
`claude.real.test.ts` is skipped unless asked, since it uses the user's login
and a little quota:

```sh
pnpm build
PASO_TEST_REAL_CLAUDE=1 pnpm exec vitest run apps/server/src/agent/claude.real.test.ts
```

Codex simulation tests use `agent/testing/fake-codex.mjs` with the real
compiled board MCP server. They cover text, tool targets and results, resume,
cancellation and child cleanup, failure codes, version rejection and unsafe
configuration. The real test is opt-in because it spends the person's quota.

```sh
pnpm build
PASO_TEST_REAL_CODEX=1 pnpm exec vitest run apps/server/src/agent/codex.real.test.ts
```

It defaults to `gpt-6-luna`. Set `PASO_TEST_CODEX_MODEL` if that model is not
available with the person's account. It checks a disk edit, resume, refusal of
shell/file/web requests and cancellation. The browser check is separate.

## Agent runs and restore points

Before an agent run starts, `POST /api/projects/:p/runs` (with optional
`{ id?, label? }`) saves a baseline restore point of the project's scenes,
steps, order lists and exact content revisions, and returns `{ run }` with
status 201 (`status: "running"`). Starting a run is an explicit route outside
the MCP tools (and is called automatically by `SessionManager` around each
session turn). Only one run may be active per project at a time; starting a
second while one is `running` returns `409 RUN_IN_PROGRESS`.

While a run is `running`, the service records only agent-created scenes and
steps, agent edits and deletions, and explicit agent order changes. The production
MCP HTTP client sends `X-Paso-Actor: mcp` on every write. Requests without that
header, including normal web-client requests, are person-authored. This is
attribution inside an authenticated local service, not a separate authorization
boundary. A client with the service token can choose its actor.

Writes are attached to the single active run for the target project. MCP writes
outside a run still succeed, but belong to no restore point and are never added
to a later run. No run ID or extra environment variable is required. Harness
sessions can start the existing compiled MCP entry point with `PASO_SERVICE_URL`
and `PASO_SESSION_TOKEN`; attribution is set by the MCP client code, independently
of the harness or its launch environment. Hosts must open the restore point
before launching the harness and finish it after its MCP processes have stopped.

The service records person edits separately, including edits before the first
agent write. Agent revisions stay distinct from person revisions. Observed
external disk changes also count as person edits.

`POST /api/projects/:p/runs/:r/finish` records the
final revisions at the end of the run and transitions it to `finished`
(idempotent if already `finished`). `GET /api/projects/:p/runs` and
`GET /api/projects/:p/runs/:r` return run summaries, change lists and any
current undo warnings.

To undo a run, first call `GET /api/projects/:p/runs/:r/undo`. This read-only
preview modifies no project files and returns `{ plan }` containing:

- `changes`: `stepsToRestore`, `stepsToRecreate`, `stepsToDelete`,
  `scenesToDelete`, `scenesToRecreate` (items with `id` and `name`),
  `scenesToKeepWithPostRunSteps` and `orderChanges`.
- `warnings`: conflict warnings naming affected steps or scenes (`STEP_MODIFIED_CONCURRENTLY`,
  `STEP_MODIFIED_AFTER_RUN`, `STEP_DELETED`, `SCENE_DELETED`,
  `SCENE_HAS_POST_RUN_STEPS`, `ORDER_MODIFIED_AFTER_RUN`,
  `ORDER_MODIFIED_CONCURRENTLY`, `SCENE_MODIFIED_CONCURRENTLY`,
  `SCENE_MODIFIED_AFTER_RUN`).
- `requiresForce`: `true` when undoing would overwrite human edits made during
  or after the run, or recreate a step that a person deleted.
- `confirmationToken`: a SHA-256 token bound to the exact plan and current
  project revisions.

To execute the undo, call `POST /api/projects/:p/runs/:r/undo` with
`{ "confirm": "<confirmationToken>", "force": true }` (`force` is required when
`requiresForce` is `true`). Missing `confirm` returns `428 CONFIRMATION_REQUIRED`;
a stale token (because any document changed after the preview) returns
`409 CONFIRMATION_MISMATCH`; omitting `force` when warnings require it returns
`409 FORCE_REQUIRED`. Undo writes through the same atomic per-file store path
and emits the normal WebSocket events (`updated`, `created`, `deleted`,
`reordered`). The run status becomes `undone` only after all project files are
updated, so any partial failure leaves the run retryable.

Undoing an older run while a newer run on the same project is still `finished`
or `interrupted` returns `409 NEWER_RUN_EXISTS`; undo the newer run first so it
becomes `undone`, after which the older run can be undone safely. Assets are
shared across steps and are never deleted by undo. Because each step is stored
as a complete snapshot, restoring a step that both the agent and a person edited
during the same run also reverts the person's edits to that step; the service
detects this and warns (`STEP_MODIFIED_CONCURRENTLY`) with the step ID and
title. Steps that only a person edited during the run (untouched by the agent)
are left untouched and have no loss warning. This also applies to person-only
creations, deletions and order changes. Removing an agent-created step or scene
does not reset the order of surviving items. Explicit agent reorders restore the
baseline order, with human-created items placed using their order before the
first agent reorder. Mixed human and agent reorders, and human reorders after
the run, warn and require `force: true`. No-op agent order requests do not count
as reorders.

A baseline step deleted by the agent is recreated. A person-deleted step is
recreated only if the agent also touched it, with `STEP_DELETED` and explicit
force. A person-deleted scene stays deleted, with `SCENE_DELETED` when a step
restore is skipped. An agent-deleted scene is listed in `scenesToRecreate` and
recreated with its recorded steps. An agent-created scene that contains
human-created steps is kept with those steps, including when they were added
during the run. `SCENE_HAS_POST_RUN_STEPS` is informational and does not itself
require force. Deleting an agent-created scene that a person renamed requires
force and a scene warning.

Restore points made before reliable attribution have no `attributionVersion: 2`.
They remain readable in history, but undo preview and execution return
`409 RUN_ATTRIBUTION_UNKNOWN`, even with force. Their authors cannot be recovered
from the old record, so applying them could silently revert person-only work.
New restore points, including interrupted ones, preserve the attribution log.

Restore points are stored as atomic JSON files outside `dataDir` (by default in
`runs/<projectId>/<runId>.json` beside the `projects` directory, configurable
via `runsDir` in `startServer` or `PASO_RUNS_DIR` in the CLI). They never appear
in project listings or trigger watcher events. On startup, any run left in
`running` state because the service stopped is marked `interrupted` and remains
undoable. The service retains the latest 10 non-active runs per project by
default (`runRetentionLimit` in `startServer`).
