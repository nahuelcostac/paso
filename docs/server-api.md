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
supported. Codex (AG-06) and `agy` (AG-07) will plug into the same interface;
until then they return 422 `HARNESS_NOT_SUPPORTED`. The harness must be
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

### Adding Codex and agy

An adapter implements `HarnessAdapter.run(request, signal)` in
`apps/server/src/agent/types.ts`: start one process for one turn, translate its
output into the events above, end with exactly one terminal event, and use
`harnessEnvironment` and `startProcess` for the environment and process tree.
Both CLIs fit this shape: `codex exec --json` with `codex exec resume <id>`,
`--ignore-user-config`, `-C` and `-s read-only` for confinement, and
`agy -p --input-format stream-json --output-format stream-json
--conversation <id>`. Their board-only policy (AG-06, AG-07) is theirs to
define and prove.

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

## Agent runs and restore points

Before an agent run starts, `POST /api/projects/:p/runs` (with optional
`{ id?, label? }`) saves a baseline restore point of the project's scenes,
steps, order lists and exact content revisions, and returns `{ run }` with
status 201 (`status: "running"`). Starting a run is an explicit route outside
the MCP tools (and is called automatically by `SessionManager` around each
session turn). Only one run may be active per project at a time; starting a
second while one is `running` returns `409 RUN_IN_PROGRESS`.

While a run is `running`, the service records which scenes and steps are
created, which steps are updated (with their resulting content revisions), and
which order lists change. `POST /api/projects/:p/runs/:r/finish` records the
final revisions at the end of the run and transitions it to `finished`
(idempotent if already `finished`). `GET /api/projects/:p/runs` and
`GET /api/projects/:p/runs/:r` return run summaries, change lists and any
current undo warnings.

To undo a run, first call `GET /api/projects/:p/runs/:r/undo`. This read-only
preview modifies nothing and returns `{ plan }` containing:
- `changes`: `stepsToRestore`, `stepsToRecreate`, `stepsToDelete`,
  `scenesToDelete`, `scenesToKeepWithPostRunSteps` and `orderChanges`.
- `warnings`: conflict warnings naming affected steps or scenes (`STEP_MODIFIED_CONCURRENTLY`,
  `STEP_MODIFIED_AFTER_RUN`, `STEP_DELETED`, `SCENE_DELETED`,
  `SCENE_HAS_POST_RUN_STEPS`, `ORDER_MODIFIED_AFTER_RUN`).
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
are left untouched when the agent edits use the MCP client or when the person's
edit happens externally on disk.

Restore points are stored as atomic JSON files outside `dataDir` (by default in
`runs/<projectId>/<runId>.json` beside the `projects` directory, configurable
via `runsDir` in `startServer` or `PASO_RUNS_DIR` in the CLI). They never appear
in project listings or trigger watcher events. On startup, any run left in
`running` state because the service stopped is marked `interrupted` and remains
undoable. The service retains the latest 10 non-active runs per project by
default (`runRetentionLimit` in `startServer`).

