# Paso: visual direction

Mockups are in `mockups/` (open the files directly; add `?theme=dark` or `?theme=light`). Screenshots are in `screens/`. Tokens are in `apps/web/src/styles/tokens.css`.

## The idea: a contact sheet on a grey table

Photographers judge frames on neutral grey, numbered in sequence, and mark the ones that matter with a pen. Paso works the same way.

- **The chrome is the table.** Grey, flat, docked to the window edges, with no colour of its own.
- **Drawings are the only paper.** White in light theme, `#121212` in dark. If it looks like paper, it is a drawing.
- **Every step is a numbered frame.** Numbers in mono are Paso's signature, not logos or illustration.
- **Colour comes from two highlighters**, always as a flat fill behind ink:
  - Lime, `--mark`: where you are, and the one primary action (Presentar).
  - Pink, `--agent`: what the agent touched. Anyone should be able to scan a board and find the agent's work at a glance.

Everything else is achromatic. A selected thing is an inverted block, in Paso's selector and in Excalidraw's toolbar alike.

This is what keeps Excalidraw the star. Its controls float, with rounded corners and soft shadows. Paso's are docked, square and flat, so anything floating belongs to the drawing engine. The hand-drawn look stays inside drawings: no sketchy borders and no Excalifont in the chrome.

**Type:** Atkinson Hyperlegible Next for UI, Atkinson Hyperlegible Mono for numbers and tool activity. It was drawn for legibility, which suits people reading on a projector, and it keeps 12px usable. Both are SIL OFL 1.1, from `@fontsource-variable/atkinson-hyperlegible-next` and `-mono` 5.3.0, and vendored in `apps/web/src/styles/fonts/` with their licences.

## Using the tokens

- `tokens.css` is already imported in `main.tsx`. It holds tokens, font faces and the Excalidraw theme, and styles no app element.
- Set `data-theme="light"` or `"dark"` on `<html>`; with neither, the OS decides. Pass the same resolved value to Excalidraw's `theme` prop.
- Colours use CSS `light-dark()`, so each pair sits on one line. It needs Chromium 123, Safari 17.5 or Firefox 120. Check this if a desktop wrapper uses an older webview.
- Use token names, never raw values. Add a token before adding a one-off.

| Need | Token |
| --- | --- |
| Any chrome background | `--table` |
| Hover, selected row, input | `--table-well` |
| Menus and popovers only | `--raised` with `--elevation-float` and `--radius-float` |
| Canvas and thumbnails | `--paper` |
| Text | `--ink`, then `--ink-2`, then `--ink-3` (all AA on every surface) |
| Selected control | `--ink` fill with `--on-ink` text |
| Current step, primary action | `--mark` fill with `--on-marker` text |
| Agent's change | `--agent` fill with `--on-marker` text; `--agent-ink` if there is no fill |
| Keyboard focus | `box-shadow: var(--focus-ring)` on `:focus-visible` |

## Component rules

**Selector (Storyboard/Lienzo).** Two text buttons, `role="radiogroup"`, arrow keys to move. The selected one is an inverted block, and there is no container around them. It sits at the top bar's left edge, in the same place in both views.

**Panels.** Projects 216px, agent 344px, top bar 44px. Same `--table` background as everything else, separated by one `--line` hairline. No shadows, no rounded corners, no second surface colour. The agent panel header shares the top bar's 44px line.

**Thumbnails.**
- White or `#121212` paper with a `--line-frame` edge and `--radius-frame`, always 16:10.
- Every step of a scene exports with the same bounds. The thumbnails are a sequence, so content must not jump when the bounding box changes. The mockups put a transparent 1000×625 rectangle in every step to fix the camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. That applies the same filter as `--thumb-filter`, and it also keeps embedded images from inverting, which the CSS filter alone cannot do. Never recolour a thumbnail by hand.
- The number sits below the frame, not on it. Current step: 2px `--ink` edge and a `--mark` number. Agent changed it: an `agente` chip. Agent is changing it now: 2px `--agent` edge and a chip reading `cambiando…`, or `agente…` in the carousel, where the longer word does not fit. Current and agent states can coexist.

**Storyboard.** A ledger, not a grid of cards: a 136px margin column with the scene number, title and step count, then four frames per row, with one hairline between scenes. Nothing sits inside a box. The dashed add-step slot in the mockup is the hover or focus state of a scene.

**Carousel.** 104px tall, in normal flow below the Excalidraw container. It must never overlap the container. Frames are 104×65, left edge at 16px, which lines up with Excalidraw's zoom controls above. Add and duplicate are pinned right so they do not move. Arrow keys move between steps only while focus is inside the carousel (see below).

**Agent activity.** Text and tool activity appear in the order they happened, without bubbles. Each tool line is one mono row, and its step chip jumps to that step. `Detener` is pinned above the composer while running. `Deshacer ejecución` closes each finished run and says how many changes it covers. On the Lienzo there is no panel, so the top bar shows who is changing which step, with `Detener`.

**Presentar.** The drawing and a step indicator at bottom right (ticks and `3/6`, in `--ink-3`), on `--paper`, with the cursor hidden. No other chrome and no markers.

**Focus.** Every interactive element gets `--focus-ring`: ink in light, lime in dark. The mockups show it on `Duplicar paso` (Lienzo) and on scene 3, step 2 (Storyboard).

## Excalidraw: measured on 0.18.1, not assumed

Measured by running the real component in a 1224×752 container, positioned as in the Lienzo. The Lienzo mockup's toolbars are a DOM snapshot of that run, and all eight controls match it to the pixel.

| Control | x, y from container | Size |
| --- | --- | --- |
| Main menu | 16, 16 | 36×36 |
| Shape toolbar | centred, y 16 | 550×44 (564 with lock) |
| Hint text | centred, y 68 | 550×24 |
| Properties panel | 16, 76 | 200 wide, 586 tall here, scrolls |
| Biblioteca | right 16, y 16 | 100×36 |
| Zoom | 16, bottom 16 | 132×36 |
| Undo and redo | 158, bottom 16 | 72×36 |
| Help | right 16, bottom 16 | 36×36 |

- **Width.** Keep the container at 808px or wider (`--canvas-min-w`), which is a 1024px window with the projects panel open; collapse that panel below it. Measured: "Biblioteca" is clipped at 732px and clear at 780px, and below 730px Excalidraw switches to its mobile layout and moves the toolbar.
- **Height.** The properties panel shrinks and scrolls with its container, ending 38px above the zoom controls. Measured with the top bar and carousel in place, at window heights of 900, 800 and 720.
- **Offline.** By default Excalifont loads from `esm.sh`. Set `window.EXCALIDRAW_ASSET_PATH` and serve a copy of the package's `dist/prod/fonts`. Verified: no external requests with this set.
- **Vite.** Add `define: { 'process.env.IS_PREACT': JSON.stringify('false') }`, or the component does not render.
- **Inherited type.** Excalidraw inherits `font-size` and `line-height`, and its panel spacing drifts if an ancestor sets them. Reset both on its wrapper: `font-size: 16px; line-height: normal`.
- **Text before fonts.** Text measured before Excalifont has loaded gets clipped on the canvas. Load the font before creating or converting text elements, which matters for agent-written scenes.
- **Theme.** `tokens.css` removes Excalidraw's violet, including the selection handles (scanned: only the unused logo colour is left). One variable drives both the active tool and all selected options in the properties panel. In a test with lime it filled the panel with six loud blocks, so keep it neutral. The canvas runs through a dark filter, which is why the dark `--color-selection` value looks wrong but renders correctly.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs.
- **Untranslated text.** With `es-ES`, some strings stay in English ("Hold Cmd and Arrow key to create a flowchart", "Find on canvas"). The custom menu fixes the second. For the hint, decide when building the Lienzo whether to hide `.HintViewer` or accept the English fragment.
- **Keyboard.** Digits 1–9 and 0 pick tools, and arrows and PageUp/PageDown are also taken. Never bind bare keys for steps while the canvas has focus.

## What to avoid

- Colour on chrome beyond the two markers. No third accent, no gradients, no glow.
- Markers used as lines or text colour. A highlighter fills behind ink. (`--agent` edges an in-progress frame, the one exception.) `--mark` matches `--table` in luminance in light theme, so never let it carry meaning alone: pair it with the ink edge, as on the current step and on Presentar via `--mark-edge`.
- Cards, card-in-card, or panels with their own background. Use a hairline.
- Shadows on anything docked. If it casts a shadow, it floats.
- Sketchy or hand-drawn styling in the chrome.
- Overlays on the canvas beyond Excalidraw's own. New controls go in the top bar or the carousel, or inside Excalidraw through `renderTopRightUI`.
- Text below 12px, and mono for prose.
- More than one `--mark` action on a screen. Presentar is the only one.

## Not yet designed

Open menus, empty states (no projects, empty scene, no agent installed), error states, and agent permission prompts. Build them from the rules above. `--raised` and `--danger-ink` are ready for them.
