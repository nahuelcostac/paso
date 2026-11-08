# AG-06 verification

Verified on macOS with Codex CLI 0.166.0 and the person's existing ChatGPT login.
The task branch is `ag-06/codex-session`. No PR was opened.

## Protocol and restrictions

The implementation uses app-server over stdio. Paso registers eleven dynamic
board tools and forwards validated calls to the compiled board MCP server.
The service token reaches only that MCP process through its environment.
The Codex process has no MCP configuration and receives no service token.

App-server was selected over `exec --json` because it lets the host validate
calls before execution and reports the effective thread policy. It also streams
text deltas and supports persistent threads. This needs a duplex process helper
but does not change `HarnessAdapter`.

A separate `CODEX_HOME`, an auth-file symlink, a restricted model catalog,
disabled features, no environment access, read-only sandbox and approval policy
`never` provide the restrictions. The model catalog is necessary because this
CLI's provider metadata can enable tools independently of feature flags.
Only CLI 0.166.0 is accepted until another version is verified. See the full
[policy](../server-api.md#codex-policy-and-protocol).

## Real CLI and compiled server

The compiled `apps/server/dist/server.js` ran through `startServer(...)` on
port 3109. Vite ran directly on port 5278. Projects, runs, workspace and Codex
state used a private temporary root. The normal dev launcher was not used.

- With `gpt-6-luna`, a real turn called `read_step` and `add_elements` on
  `ag06/scene/step`. Both succeeded. The saved step JSON contained rectangle
  `caja` and the bound label `Hola Codex`. The turn ended `completed`.
- After restarting the compiled server, the same Codex thread resumed. A
  request to execute shell, read `/etc/hosts` and download `https://example.com`
  produced `NO_PUEDO`, no tool calls and no board changes. The requested shell
  marker did not exist.
- A real resumed turn was cancelled while its CLI was running. It emitted one
  terminal event with reason `cancelled` and left the step unchanged.
- A read-only, no-inference probe confirmed the final `--strict-config`
  arguments are accepted and report `readOnly`, `networkAccess: false`,
  `approvalPolicy: never` and no instruction sources.

A real probe exposed an important resume detail. CLI 0.166.0 restores a neutral
local environment when loading a thread. The adapter clears it explicitly with
`environments: []` on **every** `turn/start`, before submitting the message.
The simulator now reproduces this behavior.

An initial availability probe rejected `gpt-5.4-mini` for this login. Subsequent
API checks used `gpt-6-luna`; the browser used the default `gpt-6.1-sol`.
No model substitution happens inside the adapter.

## Browser

The integrated preview browser timed out twice. The fallback used Playwright
installed under `/tmp/paso-ag06-browser` and cached Chromium 1243.

In a real browser, the test selected and added Codex, sent an update, observed
`LISTO_UI`, verified the live SVG thumbnail and the saved JSON both contained
`Hola navegador`, checked light and dark themes, stopped another real turn,
then confirmed undo in the app's dialog. Both the live thumbnail and JSON
returned to `Hola Codex`. The final browser check reported no page errors.

Local artifacts are in `/tmp/paso-ag06-browser/`. They include `light.png`,
`dark.png`, `undo-dark.png` and `report.json`. Sanitized real-turn evidence and
the temporary project remain under the verification root named in the task
report. Authentication contents and service tokens are absent from the report.

## Automated checks

`pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` passed.
The full default test run passed 377 tests and skipped four opt-in tests.
The build reported existing large-chunk warnings.

The Codex simulator runs against the real compiled board MCP process. It
covers streaming text, tool targets, successful and failed results, resume,
process-tree cancellation, timeout, missing CLI, signed-out account, quota,
model unavailability, version/flag rejection, unsafe permissions, unexpected
MCP servers and tools, approval requests, crashes and malformed protocol.
Panel tests cover selecting, adding and sending through Codex.

`codex.real.test.ts` provides a repeatable opt-in test for edits, resume,
file/shell/web refusal and cancellation. It is skipped in the default suite
to avoid using subscription quota. The manual compiled-server and browser
checks above were run separately.

## Limits

Windows process groups and symlink permissions, keychain-only Codex logins,
and other CLI versions were not verified. The CLI persists conversation
history under the isolated home for resume. Paso stores only session IDs and
resume tokens in its own index. Temporary verification services and browser
processes were stopped by their own PIDs.
