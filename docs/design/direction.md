# Paso: visual direction

Tokens are in `apps/web/src/styles/tokens.css`. Screenshots of the app are in `screens/`, and side-by-side comparisons with the older app this look comes from are in `compare/`.

## The idea: a calm, light workspace with one violet

This look comes from an earlier version of Paso (IN-05). It is quiet and familiar, so the drawings stand out.

- **A light grey page, white surfaces.** The page is `#f7f8fa`. The header, panels, cards, dialogs and menus are white, docked to the window and separated by thin `#e6e8ee` lines. Shadows are subtle and used only for things that float: popovers, dialogs and the hover state of a card.
- **Drawings are the paper.** The canvas fills its column edge to edge. Thumbnails sit at the top of white step cards.
- **One accent, violet `#7260d5`.** It marks selection (the open step, the current project, the view selector, selected tools in Excalidraw), keyboard focus and the primary action: Presentar, the agent's send button, and the button that creates a project's first scene.
- **One marker, pink `--agent`.** Whatever the agent touched gets a pink fill behind dark text, and the step it is changing right now gets a pink edge. Pink and violet are kept apart in role: violet means *you are here*, pink means *the agent did this*. Anyone should be able to scan a board and find the agent's work.
- **Dark theme** is the same layout on deep navy (`#12151c` page, `#1b1f29` surfaces) with the same violet and pink. Both themes are complete. Neither is derived from the other at runtime.

Excalidraw's own controls wear the same white cards, thin borders and violet, so the app reads as one object. The hand-drawn look stays inside drawings: no sketchy borders and no Excalifont in the chrome.

**Type:** Inter for everything, with tabular figures so step numbers line up. It is SIL OFL 1.1, from `@fontsource-variable/inter` 5.3.0 (weight axis, latin and latin-ext). It is vendored in `apps/web/src/styles/fonts/` with its licence (`OFL-inter.txt`), so the app works offline. Code inside agent messages uses the system monospace.

**Icons:** [Lucide](https://lucide.dev) (ISC), through `lucide-react`, which bundles with the app and works offline. Default stroke width.

## Using the tokens

- `tokens.css` is imported in `main.tsx`. It holds tokens, font faces and the Excalidraw theme, and styles no app element.
- Set `data-theme="light"` or `"dark"` on `<html>`; with neither, the OS decides. Pass the same resolved value to Excalidraw's `theme` prop.
- Colours use CSS `light-dark()`, so each pair sits on one line. It needs Chromium 123, Safari 17.5 or Firefox 120. Check this if a desktop wrapper uses an older webview.
- Use token names, never raw values. Add a token before adding a one-off.

| Need | Token |
| --- | --- |
| Window background | `--page` |
| Header, panel, card, dialog, menu | `--surface`, edged with `--line` (`--border`) |
| Hover, the selector's track, the pager, a quiet fill | `--surface-sunken` (`--surface-hover` on top of it) |
| Hovered card, input edge, dashed slot | `--line-strong` |
| Canvas and thumbnails | `--paper` |
| Text | `--ink`, then `--ink-2`, then `--ink-3`; all pass AA on the page and on surfaces |
| Icons, disabled text | `--muted` (`#8a91a0`, the reference's muted grey; it is below AA for text) |
| Selected thing | `--accent-soft` fill, `--accent-line` edge, `--accent-ink` text |
| Primary action | `--accent` fill with `--on-accent` text, `--accent-strong` on hover |
| Agent's change | `--agent` fill with `--on-agent` text; `--agent-ink` if there is no fill |
| Saved | a 6px `--ok` dot before «Guardado» |
| Errors | `--danger-ink` on `--danger-soft` |
| Keyboard focus | `box-shadow: var(--focus-ring)` on `:focus-visible` |
| Lift | `--shadow-sm` (cards), `--shadow-md` (hover, selector), `--shadow-lg` (popovers, dialogs) |

**Radii:** `--radius-sm` 6px (badges, small controls, carousel thumbnails), `--radius-md` 8px (buttons, inputs, menu items, project tiles), `--radius-card` 10px (step cards, composer, Excalidraw islands), `--radius-lg` 14px (dialogs). Pills (`--radius-pill`) are only for the agent chip.

**Type scale:** 11px for the spaced uppercase eyebrow only, 12px meta, 13px default, 15px, 20px for scene and dialog titles, 28px for the project title. Weights 400, 500, 600 and 700. Titles use `--tracking-title` (-0.02em); eyebrows use `--tracking-eyebrow` (0.16em).

**Focus:** the reference's soft violet ring, a 3px band 2px outside the element. It is one step darker than the reference (`#8f80e6`) so that it reaches 3:1 against the page.

## Component rules

**Header.** A white bar across the window, under a thin line. Its first row is a three-column grid with equal outer columns, so the view selector sits on the window's true centre in both views. Left: the «Paso.» mark (a violet tile with Paso's step glyph, the name with a violet full stop), a divider and the projects toggle. Right: on the Lienzo, «Guardado» with its dot, then the agent status, then Presentar; on the Storyboard, the agent status and Presentar's reserved slot, or the `Agente` toggle on a narrow window.

On the Lienzo the header has a **second row**: the scene selector (a bordered button with the scene's number and name), then «PASO 03» as an eyebrow and the step's title.

**Selector (Storyboard/Lienzo).** A grey track with a thin border. The selected option is a raised white segment with violet text. It is a `role="radiogroup"`, moved with the arrow keys.

**Projects.** A white column docked on the left, 240px. «PROYECTOS» is an eyebrow. Each project is a 34px icon tile, its name and its size (`4 escenas · 17 pasos`). The current project has a violet-tinted row with a violet edge, and its tile is solid violet. Clicking the tile opens the icon picker. The footer says «Guardado en este equipo» after a green dot.

**Storyboard.** Under the header, on the grey page:
- The project: the eyebrow «TU EXPLICACIÓN, PASO A PASO», the title at 28px, and its size. «Nueva escena» is a bordered secondary button on the right.
- Each scene sits under a thin rule: the eyebrow «ESCENA 2 DE 3», the title at 20px, and the step count in a small bordered counter. The drag handle and menu appear on hover or focus.
- Steps are white cards in a grid (minimum 208px wide): the thumbnail on top, with the step number in a small bordered badge on its top-left corner, then the title. An untitled step reads «Sin título» in `--ink-3`.
- The last cell of every scene is the dashed «El siguiente paso» card, with a violet `+` tile. It is always shown.

**Thumbnails.**
- `--paper`, always 16:10. Every step of a scene exports with the same bounds: the thumbnails are a sequence, so content must not jump when the bounding box changes. An empty scene uses a 1000×625 camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. Never recolour a thumbnail by hand.
- Current step: violet edge with a soft violet halo, and a solid violet number badge. Agent changed it: a pink `agente` chip after the title. Agent is changing it now: a 2px pink edge and a chip reading `cambiando…` (`agente…` in the carousel). Current and agent states can coexist; the pink edge wins and the violet halo stays outside it.
- In the carousel, which has no room for a title, the number sits under the thumbnail and the title goes in the tooltip.

**Lienzo.** The canvas fills its column edge to edge, on `--paper`.

**Carousel.** A 108px white bar under a thin line, in normal flow below the Excalidraw container. It must never overlap the container. Frames are 104×65, and the strip's left edge lines up with Excalidraw's zoom controls above. Next come the pager «03 / 06» on a grey pill (current number in bold violet), then «Añadir paso» and «Duplicar paso», pinned right.

**Carousel behaviour.** The strip scrolls and keeps the open step in view; Añadir and Duplicar stay pinned. Both start from the open step and both put the new step right after it:
- *Añadir paso* copies the drawing (same element IDs) and starts without title or speaker notes, because it is a new beat.
- *Duplicar paso* is an exact copy, title and notes included.
- Arrow keys, Home and End move between steps while focus is in the strip. Alt and the arrows move the step; Delete asks before removing it; a thumbnail can also be dragged. A new canvas does not take focus from the keyboard while the strip is in use.
- Deleting the open step opens the next one, or the previous one when it was the last. Deleting the last step leaves an empty scene with *Añadir paso* ready.

**Agent chat.** A white column docked on the right of the Storyboard, 360px, with a header row for the target (a scene or the whole project) and «Nueva conversación».
- The person's message: right-aligned, 82% maximum width, `--accent-soft`. No name or avatar.
- The agent's text: bare, on the panel. No bubble.
- Tool activity: one 26px row per tool, a 16px Lucide icon, muted detail after the label. The step number is a pink chip that jumps to that step.
- Composer: a white card with a `--line-strong` edge that takes the focus ring while its text has focus. Agent and model pickers are ghost controls in its footer. The square 32px button on the right sends (violet) and becomes stop (ink, never red) while the agent works.
- `Deshacer ejecución` sits in violet in the meta line under each finished run, with its time and how many changes it covers. The undo dialog lists what will happen in a grey box, then the warnings.
- Before the first message, adding a harness is asked once, in a notice in the panel.

On the Lienzo there is no panel, so the header shows who is changing which step, with `Detener`. Under 1160px only the chip and `Detener` remain. **Under 1100px** the Storyboard keeps no column for the panel: a bordered `Agente` button takes Presentar's slot and opens the panel as a drawer from the right edge, under the header; Escape or its close button hides it.

**Presentar.** The drawing fills the screen on `--paper`. A minimal frame floats over it: the «Paso.» mark top left and «Salir Esc» top right; the step's title bottom left, «← → para navegar» bottom right. All of this fades out with the pointer, after two seconds. The pager stays: centred at the bottom on a grey pill, with ticks (violet for the current step) and «03 / 06». «Salir» is reached with the mouse; Esc stays the keyboard's way out, because Tab is kept from wandering to the app underneath.
- One camera per scene, from the union of all its steps and the screen (`present/framing.ts`), so whatever stays still between steps stays still on screen. Margins are 5% and 6% of the screen, never less than 32px and 48px. A scene under 480×300 is framed as if it were that size, so a small sketch is not blown up to the edges.
- A step with its own canvas colour fills the screen with it, through the same dark filter as its drawing.
- Above 24 steps, or under 480px wide, the pager drops the ticks and keeps the numbers.

**Dialogs and menus.** Dialogs are white, 14px radius, with a large shadow over a dim scrim. They have a 20px title and the actions on the right under a thin rule; the destructive action is red text on a pale red fill. Menus and popovers are white cards with a thin line and a large shadow. Items have 6px radius and a grey hover, and a checked item is violet-tinted.

## Excalidraw: measured on 0.18.1, not assumed

Measured by running the real component in a 1184×724 container, positioned as in the Lienzo.

| Control | x, y from container | Size |
| --- | --- | --- |
| Main menu | 16, 16 | 36×36 |
| Shape toolbar | centred, y 16 | 550×44 (564 with lock) |
| Hint text | centred, y 68 | 550×24 |
| Properties panel | 16, 76 | 200 wide, scrolls |
| Biblioteca | right 16, y 16 | 100×36 |
| Zoom | 16, bottom 16 | 132×36 |
| Undo and redo | 158, bottom 16 | 72×36 |
| Help | right 16, bottom 16 | 36×36 |

- **Width.** Keep the container at 808px or wider (`--canvas-min-w`). That is the case with the projects panel open (240px and its line) down to a 1064px window. Below that, collapse the panel. Measured: "Biblioteca" is clipped at 732px and clear at 780px, and below 730px Excalidraw switches to its mobile layout and moves the toolbar.
- **Height.** The properties panel shrinks and scrolls with its container, ending 38px above the zoom controls. Re-measured with the two-row header and the carousel in a 1280×720 window (IN-05).
- **Offline.** By default Excalifont loads from `esm.sh`. Set `window.EXCALIDRAW_ASSET_PATH` and serve a copy of the package's `dist/prod/fonts`. Verified: no external requests with this set.
- **Vite.** Add `define: { 'process.env.IS_PREACT': JSON.stringify('false') }`, or the component does not render.
- **Inherited type.** Excalidraw inherits `font-size` and `line-height`, and its panel spacing drifts if an ancestor sets them. Reset both on its wrapper: `font-size: 16px; line-height: normal`.
- **Text before fonts.** Text measured before Excalifont has loaded gets clipped on the canvas. Load the font before creating or converting text elements, which matters for agent-written scenes.
- **Theme.** `tokens.css` maps Excalidraw's primary colours to Paso's violet, its islands and corner buttons to white cards with a thin line, and its UI font to Inter. One variable drives both the active tool and all selected options in the properties panel. It is the soft violet tint (`--accent-soft`), as in Excalidraw's own default, so a panel full of selected options stays calm.
- **Selection colour.** `--color-selection` goes straight to the canvas, which rejects `light-dark()` and silently draws black, so each theme sets a literal: `#7260d5` in light, and `#6957c9` in dark. The dark canvas runs through Excalidraw's filter, which turns `#6957c9` into about `#9d8ef0`.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs.
- **Untranslated text.** With `es-ES`, the hint has an English flowchart fragment. The Lienzo hides `.HintViewer`.
- **Keyboard.** Digits 1–9 and 0 pick tools, and arrows and PageUp/PageDown are also taken. Never bind bare keys for steps while the canvas has focus.

## What to avoid

- Translucency, blur and glass, and warm or beige neutrals. Neutrals are cool greys.
- More colours in the chrome. Violet and pink are the only hues; green appears only as the saved dot, and red only for errors and destructive actions.
- Violet for the agent's work or pink for selection. Each has one meaning.
- Heavy shadows on things that rest on the page. Cards get `--shadow-sm` at most; lift is for hover and for what floats.
- Cards inside cards. Use a thin line or space.
- Sketchy or hand-drawn styling in the chrome.
- Overlays on the canvas beyond Excalidraw's own. New controls go in the header or the carousel, or inside Excalidraw through `renderTopRightUI`.
- Text below 12px, except the uppercase eyebrow.
- Absolutely placed elements, such as visually hidden live regions, inside a scroll container that is not positioned. Their containing block becomes the window, and they make the whole document scroll. `.board` is `position: relative` for this reason.
