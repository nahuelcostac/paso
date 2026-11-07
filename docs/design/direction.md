# Paso: visual direction

Mockups are in `mockups/` (open the files directly; add `?theme=dark` or `?theme=light`). Screenshots are in `screens/`. Tokens are in `apps/web/src/styles/tokens.css`.

## The idea: paper on a beige table, tools made of glass

A warm table, sheets of paper resting on it, and glass tools floating just above.

- **The table is beige.** Warm and calm, never grey. A very soft tonal wash runs across it, because glass on a flat colour looks like plain fill.
- **Tools are glass.** Panels, bars and controls float 8px apart, rounded and translucent, with a bright top edge. Nothing is docked to the window and nothing is square.
- **Drawings are the only paper.** White in light theme, `#121212` in dark, resting on the table with a soft shadow. If it looks like paper, it is a drawing.
- **Every step is a numbered frame.** Numbers in mono are Paso's signature.
- **Colour comes from two highlighters**, always as a flat fill behind ink:
  - Lime, `--mark`: where you are, and the one primary action (Presentar).
  - Pink, `--agent`: what the agent touched. Anyone should be able to scan a board and find the agent's work at a glance.

Everything else is warm neutral. A selected thing is an inverted pill, in Paso's selector and in Excalidraw's toolbar alike.

Excalidraw stays the star because its canvas is the largest sheet of paper on screen, and its controls wear the same glass as Paso's, so the app reads as one object. The hand-drawn look stays inside drawings: no sketchy borders and no Excalifont in the chrome.

**Type:** Atkinson Hyperlegible Next for UI, Atkinson Hyperlegible Mono for numbers. It was drawn for legibility, which suits people reading on a projector, and it keeps 12px usable. Both are SIL OFL 1.1, from `@fontsource-variable/atkinson-hyperlegible-next` and `-mono` 5.3.0, and vendored in `apps/web/src/styles/fonts/` with their licences.

**Icons:** [Lucide](https://lucide.dev) (ISC), through `lucide-react`, which bundles with the app and works offline. Default stroke width. The mockups inline the real geometry from `lucide-static` 0.545.0; each `<svg>` names its icon in `data-lucide`.

## Using the tokens

- `tokens.css` is already imported in `main.tsx`. It holds tokens, font faces and the Excalidraw theme, and styles no app element.
- Set `data-theme="light"` or `"dark"` on `<html>`; with neither, the OS decides. Pass the same resolved value to Excalidraw's `theme` prop.
- Colours use CSS `light-dark()`, so each pair sits on one line. It needs Chromium 123, Safari 17.5 or Firefox 120. Check this if a desktop wrapper uses an older webview.
- Use token names, never raw values. Add a token before adding a one-off.

| Need | Token |
| --- | --- |
| Window background | `--table-wash` |
| Panel, bar, floating control | `--glass-sheen` over `--glass`, with `--glass-filter` and `--glass-shadow` |
| Composer, menu, popover | `--glass-raised` instead of `--glass` |
| Hover, selected row, user's chat bubble | `--table-well` |
| Canvas and thumbnails | `--paper` with `--shadow-paper` |
| Text | `--ink`, then `--ink-2`, then `--ink-3` (all AA on every surface) |
| Selected control | `--ink` fill with `--on-ink` text |
| Current step, current project, primary action | `--mark` fill with `--on-marker` text |
| Agent's change | `--agent` fill with `--on-marker` text; `--agent-ink` if there is no fill |
| Keyboard focus | `box-shadow: var(--focus-ring)` on `:focus-visible` |

## Glass rules

- **It does not nest.** `backdrop-filter` inside a blurred parent cannot see past that parent, so what lies behind shows through sharp. Mount menus and popovers outside the panel, through a portal. The composer may sit inside the agent panel because `--glass-raised` is opaque enough without its own blur.
- **Give it something to blur.** Content scrolls under glass where the layout allows: the storyboard runs under the selector (see `storyboard-scrolled-*.png`).
- **Radii are concentric.** An inner radius is the outer one minus the gap: 24px panel, 8px gap, 16px card. Pills are for buttons and chips.
- **Less transparency.** `prefers-reduced-transparency` swaps the glass for solid surfaces in `tokens.css`, with no other change.
- **Contrast is measured on the composite**, not on the token: text was checked over each glass stack on both extremes of the wash. Re-check after changing any alpha. This caught failures the token values alone hid.

## Component rules

**Top bar.** It spans the window, on a three-column grid with equal outer columns, so the selector sits on the window's true centre in both views and never moves. Left: brand, then the scene selector on the Lienzo. Right: agent status and Presentar.

**Selector (Storyboard/Lienzo).** A glass capsule with two text buttons, `role="radiogroup"`, arrow keys to move. The selected one is an inverted pill.

**Projects.** Each project is an object, not a line of text: a 36px icon tile, its name, and its size (`4 escenas · 17 pasos`). The tile is a small sheet of paper holding a Lucide icon; the current project's tile is lime. Clicking the tile opens the icon picker (`storyboard-icon-picker.html`): a search field and a grid of Lucide icons. Agents can set the icon too. The project needs a stored icon name; that field is not in `packages/shared` yet.

**Panels.** Projects 232px, agent 360px. Canvas, carousel and panels all use `--radius-panel`, 8px apart and 8px from the window edge.

**Thumbnails.**
- `--paper` with `--shadow-paper`, always 16:10. `--radius-frame` on the storyboard, `--radius-frame-small` in the carousel.
- Every step of a scene exports with the same bounds. The thumbnails are a sequence, so content must not jump when the bounding box changes. The mockups put a transparent 1000×625 rectangle in every step to fix the camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. That applies the same filter as `--thumb-filter`, and it also keeps embedded images from inverting, which the CSS filter alone cannot do. Never recolour a thumbnail by hand.
- The number sits below the frame, not on it. Current step: 2px `--ink` edge and a lime number. Agent changed it: an `agente` chip. Agent is changing it now: 2px `--agent` edge and a chip reading `cambiando…`, or `agente…` in the carousel, where the longer word does not fit. Current and agent states can coexist.

**Storyboard.** Scenes sit directly on the table, separated by space alone: no rules and no cards. Scene number, title and step count on one line, then four frames per row. The dashed add-step slot in the mockup is the hover or focus state of a scene.

**Carousel.** 108px glass bar, in normal flow below the Excalidraw container. It must never overlap the container. Frames are 104×65, left edge at 16px, which lines up with Excalidraw's zoom controls above. Add and duplicate are pinned right so they do not move. Arrow keys move between steps only while focus is inside the carousel (see below).

**Agent chat.** It follows T3 Code's anatomy, read from its source (`pingdotgg/t3code`, `apps/web/src/components/chat/`):
- The person's message: right-aligned bubble, 80% maximum width, `--radius-card`, `--table-well`. No name or avatar.
- The agent's text: bare, on the panel. No bubble.
- Tool activity: one 24px sans row per tool, a 16px Lucide icon, muted detail after the label. Here the step number is a pink chip that jumps to that step.
- Composer: a `--glass-raised` card at `--radius-card`, with text on top and controls in its footer. Agent and model pickers are ghost controls in that footer, not in a panel header. The round 32px button on the right sends, and becomes stop while the agent works.
- `Deshacer ejecución` sits in the meta line under each finished run, with its time and how many changes it covers.
- Paso's differences: 13px text for the narrower panel, and an ink stop button instead of T3 Code's red, so that no third colour enters the chrome.

On the Lienzo there is no panel, so the top bar shows who is changing which step, with `Detener`. Under 1160px the sentence would hit the selector, so only the chip and `Detener` remain.

**Presentar.** The drawing and a step indicator at bottom right (ticks and `3/6`, in `--ink-3`), on `--paper`, with the cursor hidden. No other chrome, no glass and no markers.

**Focus.** Every interactive element gets `--focus-ring`: ink in light, lime in dark. The mockups show it on `Duplicar paso` (Lienzo) and on scene 3, step 2 (Storyboard).

## Excalidraw: measured on 0.18.1, not assumed

Measured by running the real component in a 1184×724 container, positioned as in the Lienzo. The Lienzo mockup's toolbars are a DOM snapshot of that run, and all eight controls match it to the pixel.

| Control | x, y from container | Size |
| --- | --- | --- |
| Main menu | 16, 16 | 36×36 |
| Shape toolbar | centred, y 16 | 550×44 (564 with lock) |
| Hint text | centred, y 68 | 550×24 |
| Properties panel | 16, 76 | 200 wide, 558 tall here, scrolls |
| Biblioteca | right 16, y 16 | 100×36 |
| Zoom | 16, bottom 16 | 132×36 |
| Undo and redo | 158, bottom 16 | 72×36 |
| Help | right 16, bottom 16 | 36×36 |

- **Width.** Keep the container at 808px or wider (`--canvas-min-w`), which is a 1064px window with the projects panel open; collapse that panel below it. Measured: "Biblioteca" is clipped at 732px and clear at 780px, and below 730px Excalidraw switches to its mobile layout and moves the toolbar.
- **Height.** The properties panel shrinks and scrolls with its container, ending 38px above the zoom controls. Measured with the top bar and carousel in place, at window heights of 900, 800 and 720.
- **Offline.** By default Excalifont loads from `esm.sh`. Set `window.EXCALIDRAW_ASSET_PATH` and serve a copy of the package's `dist/prod/fonts`. Verified: no external requests with this set.
- **Vite.** Add `define: { 'process.env.IS_PREACT': JSON.stringify('false') }`, or the component does not render.
- **Inherited type.** Excalidraw inherits `font-size` and `line-height`, and its panel spacing drifts if an ancestor sets them. Reset both on its wrapper: `font-size: 16px; line-height: normal`.
- **Text before fonts.** Text measured before Excalifont has loaded gets clipped on the canvas. Load the font before creating or converting text elements, which matters for agent-written scenes.
- **Theme.** `tokens.css` removes Excalidraw's violet (scanned: only the unused logo colour is left), rounds its controls, and gives its islands and corner buttons the same glass. Their radius and blur were confirmed as computed styles on the real component. One variable drives both the active tool and all selected options in the properties panel. In a test with lime it filled the panel with six loud blocks, so keep it neutral.
- **Selection colour.** `--color-selection` goes straight to the canvas, which rejects `light-dark()` and silently draws black, so each theme sets a literal. The dark value looks wrong because the canvas runs through a dark filter; it renders as `--ink-2`. Verified from pixels on the real component in both themes.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs.
- **Untranslated text.** With `es-ES`, some strings stay in English ("Hold Cmd and Arrow key to create a flowchart", "Find on canvas"). The custom menu fixes the second. For the hint, decide when building the Lienzo whether to hide `.HintViewer` or accept the English fragment.
- **Keyboard.** Digits 1–9 and 0 pick tools, and arrows and PageUp/PageDown are also taken. Never bind bare keys for steps while the canvas has focus.

## What to avoid

- Grey. Every neutral here is warm.
- Colour on chrome beyond the two markers. No third accent and no glow. The table's wash is the only gradient, and it stays a tonal shift of beige.
- Markers used as lines or text colour. A highlighter fills behind ink. (`--agent` edges an in-progress frame, the one exception.) `--mark` matches the table in luminance in light theme, so never let it carry meaning alone: pair it with an edge, as on the current step and on Presentar via `--mark-edge`.
- Cards inside cards, and glass inside blurred glass. Use space before a hairline.
- Square corners and docked bars.
- Sketchy or hand-drawn styling in the chrome.
- Overlays on the canvas beyond Excalidraw's own. New controls go in the top bar or the carousel, or inside Excalidraw through `renderTopRightUI`.
- Text below 12px, and mono for prose or tool activity.
- More than one `--mark` action on a screen. Presentar is the only one.

## Not yet designed

Open menus other than the icon picker, empty states (no projects, empty scene, no agent installed), error states, and agent permission prompts. Build them from the rules above. `--glass-raised` and `--danger-ink` are ready for them.
