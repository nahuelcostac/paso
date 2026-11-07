# LYP-01 implementation and verification

Verified on 2026-11-07 in `lyp-01/excalidraw-step-editor`.

## Behaviour

The route is `#/<project>/lienzo/<scene>/<step>`. The view selector preserves the
scene and step. The minimal selector is labelled **Selector temporal**. It can
create scenes and steps, including the first scene or first step of an empty
project. It is not the LYP-02 carousel.

`apps/web/src/editor/step-store.ts` owns detached sessions keyed by project,
scene and step. Debounced saves capture the target, document, binary data,
revision and edit generation. Saves for one step are serial. Switching does not
wait for a slow response and does not change that response's destination.
Edits made during a save are sent in the next save using the returned revision.

The first canvas change establishes a render baseline without saving Excalidraw
normalization. Later comparisons use elements, the parsed shared appState
allow-list and the files manifest. Selection, zoom, scroll and theme do not
save. Unknown element fields and deleted-element tombstones are retained.

Each edit queues an IndexedDB recovery snapshot, including pending image bytes.
Failed saves retain that snapshot and the canvas. The person can retry. Conflicts
stop writes and offer a download of the local recovery document. Loading the
service copy first downloads the local copy. It checks for edits and events
received during that request before replacing the canvas. A top-bar notice also
points to a failed or conflicted step after the person leaves it.

The existing authenticated event stream feeds the step store. Clean steps reload
on external changes. Dirty steps become conflicts. Events during the first GET,
events before the PUT response, edits during a GET and late callbacks from an
old canvas are covered separately. A reconnect rechecks loaded revisions.
There is no element-level merge.

Page hide, pagehide, beforeunload and leaving the editor flush pending work.
Close uses keepalive and a beforeunload guard. Browser keepalive requests have
size limits. IndexedDB recovery is therefore part of the close path, including
images. A browser process killed without lifecycle events cannot guarantee a
network save. That forced-kill case was not tested.

Images upload to immutable project assets before the step manifest is saved.
Reopening reconstructs authenticated binary files from the manifest. Duplication
keeps the same asset reference and does not create another binary.

## Thumbnail consumer API

Import `ThumbnailCache` from `apps/web/src/editor/thumbnails.ts` on demand.
`cache.scene(api, projectId, sceneId, theme)` returns ordered objects with
`stepId`, `revision`, `bounds` and an SVG string. It does not mount a canvas or
write project files. Consumers own any blob URLs that they create.

Bounds use Excalidraw's bounds for all non-deleted elements across the scene,
then add 32 scene units of padding and expand to 16:10. Empty scenes use
1000 by 625. An invisible export-only rectangle sets the same camera for every
step. The cache key includes the service, project, scene, theme and every step's
revision. A change in another step invalidates the camera too. The default
cache limit is 24 scene exports. `clear()` releases the cached SVG strings.

## Direction brief checks

- Excalidraw is exactly 0.18.1, only in apps/web. The Lienzo and editor are lazy.
- EXCALIDRAW_ASSET_PATH points to the local package font copy. Vite serves that
  copy in development and copies it into dist for production.
- Vite defines process.env.IS_PREACT as the string false.
- The editor wrapper computes to 16px and normal line-height.
- The public exportToCanvas API loads the exact Excalidraw font faces before
  text dimensions are restored. The probe does not measure text first.
- es-ES is set. The partly English HintViewer is hidden. The custom MainMenu
  contains only image export and background colour. It has no external links.
- The app's resolved OS or explicit theme is passed to Excalidraw. The existing
  Paso token overrides load after Excalidraw CSS. In both themes the measured
  toolbar radius is 14px and its filter is blur(24px) saturate(1.5).
- The canvas minimum is 808px. At a 1000px window the projects panel collapses.
- Excalidraw handles keys only while focused. Digits, arrows and PageDown did
  not change the step route. Paso adds no bare-key canvas navigation.

## Checks run

All final checks passed.

| Command | Result |
| --- | --- |
| pnpm lint | Passed |
| pnpm typecheck | Passed in all packages |
| pnpm test | 11 files, 133 tests passed |
| pnpm build | Passed, including the local font copy |
| git diff --check | Passed |

The first sandboxed suite could not listen on loopback. The complete suite was
then run with the required localhost permission. An early new unit test omitted
the persisted background in its view-only input. That test input was corrected.
The final suite above has no failures.

The build reports upstream large chunks and Zod pure-annotation warnings. They
do not fail the build. Installation reports older Radix peer ranges for React
19. The real React 19 editor passed the checks below.

## Real browser checks

Playwright 1.58.2 was installed only in `/tmp/paso-lyp01-browser`. Cached
Chromium 1243 was used. No browser automation dependency was added to the repo.
The main script used the compiled local service on port 3005 and the Vite app
on port 5175, with `/tmp/paso-lyp01-data`. Ports 5173 and 3001 were left for the
existing app. Temporary production verification served dist on port 5176,
with a separate compiled service, separate data directory and trusted session
injection. Production files contain no session token.

The following passed in both light and dark themes against the real service.

1. Start from an empty project, create its first scene and step.
2. Draw rectangles in A and ellipses in B. Hold a successful PUT response for
   450ms while switching. Switch six times while adding more content.
3. Compare the renderer's live element data with each step JSON on disk.
   Reload both steps and compare again. No elements crossed between steps.
4. Confirm selection and zoom alone send no PUT.
5. Insert an SVG image through the image picker, reload and check the renderer,
   manifest and asset bytes. Headless Chromium used the standard file-input
   fallback because its native File System Access dialog cannot be automated.
6. Change a clean step through a second API client and observe live reload.
   Change a dirty step externally and observe conflict with the local drawing
   still intact.
7. Open all four demo steps, compare element counts, text and loaded image
   data with the JSON. Loading the demo sends no PUT. Its existing geometry
   renders correctly, so no demo JSON changes were needed.
8. Export the demo scene with exportToSvg. All steps have identical bounds,
   images embed correctly, both themes render, and the second call hits cache.
9. Record all requests and page errors. Both themes had zero external HTTP
   requests and zero page errors. This also passed for the production build.

Additional browser checks passed.

- A failed save kept its canvas and recovery data across a step switch and a
  full reload. The global notice returned to the correct step. Retry saved it.
- Hiding the page started the save before the 500ms debounce, measured at 20ms.
- Closing before debounce and reopening preserved the new elements and saved
  the same elements on disk.
- An empty scene offered and created its first step.
- Explicit light/dark app theme changes override the OS and reach Excalidraw.
- The 808px minimum, automatic panel collapse, custom menu and canvas keys work.
- Duplicating a step with an inserted image preserves its manifest and asset
  file count. The duplicate image loads again after reload.
- Conflict resolution downloaded the local recovery JSON before loading the
  service version. The downloaded copy retained local edits and did not contain
  the external element. The reloaded canvas contained the external element.
- Accented Excalifont text, `Árbol, niño y explicación`, renders without clipping.
  Its saved dimensions are 227.99981689453125 by 25, font family 5. Reload leaves
  the step JSON bytes unchanged.

Temporary browser scripts and machine-readable results are in
`/tmp/paso-lyp01-browser`. The scripts use read-only React internals only to
compare the actual renderer with disk. Production app code uses public APIs.

## Screenshots

These screenshots were inspected against the Lienzo mockup. They are temporary
and are not committed. The canvas and controls match the intended tokens and
spacing. The temporary selector uses one extra row, and the final carousel,
agent controls and Presentar remain outside this task.

- /tmp/paso-lyp01-browser/edited-light.png
- /tmp/paso-lyp01-browser/edited-dark.png
- /tmp/paso-lyp01-browser/demo-light.png
- /tmp/paso-lyp01-browser/demo-dark.png
- /tmp/paso-lyp01-browser/conflict-light.png
- /tmp/paso-lyp01-browser/conflict-dark.png
- /tmp/paso-lyp01-browser/recovery-failed.png
- /tmp/paso-lyp01-browser/production-light.png
- /tmp/paso-lyp01-browser/production-dark.png
- /tmp/paso-lyp01-browser/thumbnails-light.png
- /tmp/paso-lyp01-browser/thumbnails-dark.png
- /tmp/paso-lyp01-browser/text-light.png

## Bundle impact

A baseline build from the original HEAD was made in a temporary folder using
the same installed tooling. Decimal kB and MB are used here.

| Item | Before | After |
| --- | --- | --- |
| Initial app JavaScript | 350.09 kB | 459.74 kB |
| Initial app JavaScript, gzip | 101.75 kB | 133.68 kB |
| Initial CSS | 19.33 kB | 20.17 kB |
| Complete dist, logical bytes | 0.45 MB | 21.59 MB |

The initial JS increase is 109.65 kB, or 31.93 kB gzip. It includes the shared
schemas and persistence owner. Production network capture confirms that
Storyboard requests only the initial JS entry and no editor JS or CSS.
The first Lienzo opens another 1,184,688 bytes of JS across eight lazy chunks,
391,058 bytes gzip, plus the 152.70 kB editor stylesheet, 24.86 kB gzip. The
full distribution includes other on-demand upstream features and all drawing
font subsets. Fonts account for 13.27 MB of logical bytes and load on demand.

## Try it

From the repository root, with the normal local ports free.

```sh
pnpm install --frozen-lockfile
export PASO_DATA_DIR="$(mktemp -d /tmp/paso-lyp01.XXXXXX)"
cp -R examples/demo-project "$PASO_DATA_DIR/8102c635-b675-431b-961a-59bca74677d8"
pnpm dev
```

Open <http://127.0.0.1:5173/#/8102c635-b675-431b-961a-59bca74677d8/lienzo>.
Create a fresh project to try the empty state. Scene and step IDs are added to
the route automatically. Stop pnpm dev with Ctrl+C. The temporary directory
contains the readable JSON and shared image assets for inspection.

## Human review decisions and limits

- The temporary selector names new scenes Escena 1, Escena 2 and so on. It
  intentionally has no final carousel design.
- The whole partly English hint is hidden, including its Spanish fragments.
- Conflict resolution offers a downloadable local recovery document, then an
  explicit service reload. The download wraps the shared step with its base
  revision and pending image bytes. It is a recovery artifact, not a new project
  format or a general import feature.
- Thumbnail camera padding is 32 scene units. A step growing the scene changes
  the camera for all its thumbnails, and invalidates their revision cache.
- Recovery is kept in this browser profile. The service remains the shared
  source after successful saving. Clearing browser storage removes recovery.
- Desktop wrappers, other browsers and a forced browser process kill were not
  tested. Normal Chromium hide, close and reload were tested.

No board operation, push, PR or merge was performed. The task is ready for human
review. Processes started for verification are stopped before handoff.
