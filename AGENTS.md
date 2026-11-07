# Agent instructions

**Paso** is a local-first whiteboard editor built on Excalidraw for explaining concepts step by step and presenting them. People and their own AI agents edit the same boards. It runs as a web app today and must remain packageable with Electron or Tauri.

## Layout and boundaries

- `packages/shared`: data model and format. Browser-safe: no Node imports and no Excalidraw dependency.
- `apps/server`: local service, embeddable through `startServer(...)`. Listens on localhost only and has no browser dependency.
- `apps/web`: Vite + React UI. It reaches data only through the server API.
- Details: `docs/data-format.md` and `docs/design/direction.md`.

## Decisions already made

Ask the human before reopening any of these.

- Project > scenes > steps. Each step is a complete snapshot, and duplicating one keeps its element IDs.
- Each project is a readable folder with one JSON file per step.
- Agent changes appear live on the canvas, and each run can be undone in one action.
- In-app agents run on the user's own harnesses (`claude`, `codex`, `agy`). The app never stores API keys. By default they get only the board tools, with no shell or file editing.
- The app works offline: no assets from a CDN. The UI language is Spanish.

## Commands

`pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Workflow

Each task has one owner at each stage:

1. The **human** approves the task on the board and asks the orchestrator to start it.
2. The **orchestrator** runs `kanvas start`, then delegates to a **subagent** with a brief, a worktree and a branch. It only assigns work and moves tasks on the board.
3. The **subagent** implements, verifies, commits to its branch and reports back with evidence.
4. The **orchestrator** runs `kanvas finish` and gives the human the link to the subagent's thread.
5. The **human** asks the subagent directly for any changes. The subagent applies them on the same branch, and the task stays in review.
6. The **human** accepts the task on the board and says so in the subagent's thread.
7. The **subagent** updates its branch from `main`, reruns the checks, pushes and opens a PR. If a conflict is not trivial, it asks the human. Agents never merge.
8. The **human** merges the PR on GitHub.
9. The **orchestrator** tells the human which tasks are ready. Tasks that depend on this one start only after the merge.

Task branches are named `<task-id>/<slug>`, such as `fn-03/data-service`. Rename an auto-generated branch before pushing. PR titles start with the task ID.

## The board

`kanvas.json` is untracked and exists only in the main checkout. Only the orchestrator uses it, following `.agents/skills/kanvas/SKILL.md`.

If your checkout has no `kanvas.json`, you are in a task worktree: do not create one or run the Kanvas CLI.

## Verification

Before reporting a task as finished:

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- For UI changes, open the app in a real browser and check the result in both themes.
- For server changes, also run the compiled server, not just the dev server.
- Add tests for the behaviour you changed.

Report what you ran and the real results, and state plainly anything you could not verify.
