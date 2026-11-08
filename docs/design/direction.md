# Paso: visual direction

Tokens are in `apps/web/src/styles/tokens.css`. Screenshots of the app are in `screens/`, and side-by-side comparisons with the older app this look comes from are in `compare/`.

## The idea: warm paper and ink

The layout and type come from an earlier version of Paso (IN-05), and the floating panels and the chat from the Paso just before it. The colours are one family: layers of the same warm paper, written on in ink, with pink as the only hue. It is quiet and familiar, so the drawings stand out.

- **Layers of one paper.** The workspace behind the Storyboard and around the panels is a warm off-white (`#fbfaf8`). The chrome (the header, the projects, the chat, dialogs and menus) is the same paper one tone deeper (`#f4f1eb`), with thin warm lines and warm shadows. Step cards and what you type into are plain white (the `--work-*` tokens, swapped in on `.board`). The projects and the chat are cards that float with an 8px gutter and 20px corners. Everything is solid: no translucency or blur.
- **Drawings are the paper.** In the Lienzo the canvas and its step strip are one white card, floating with the same 8px gutter and 20px corners as the panels, so nothing edge-to-edge meets a floating card. Thumbnails sit at the top of the white step cards.
- **Ink is the accent.** `--accent` is `--ink`. The near-black marks actions (Presentar, the chat's send button, the button that creates a project's first scene), the chosen view, the open step (an ink edge and number) and the current project (an ink tile on a warm grey row). A selected option is a warm grey fill (`--accent-soft`). Focus is a warm grey ring.
- **One marker, pink `--agent`.** Whatever the agent touched gets a pink fill behind dark text, and the step it is changing right now gets a pink edge. It is the only hue in the chrome: ink means *you are here* or *do this*, pink means *the agent did this*. Anyone should be able to scan a board and find the agent's work.
- **Dark theme** mirrors the layers: the workspace is the deepest warm black (`#141210`), cards a step up (`#1d1a16`) and the chrome another (`#221f1a`), with light ink as the accent and the same pink. Both themes are complete. Neither is derived from the other at runtime.

Excalidraw's own controls wear the same paper cards, thin borders and ink, so the app reads as one object. The hand-drawn look stays inside drawings: no sketchy borders and no Excalifont in the chrome.

**Type:** Inter for everything, with tabular figures so step numbers line up. It is SIL OFL 1.1, from `@fontsource-variable/inter` 5.3.0 (weight axis, latin and latin-ext). It is vendored in `apps/web/src/styles/fonts/` with its licence (`OFL-inter.txt`), so the app works offline. Code inside agent messages uses the system monospace.

**Icons:** [Lucide](https://lucide.dev) (ISC), through `lucide-react`, which bundles with the app and works offline. Default stroke width.

## Using the tokens

- `tokens.css` is imported in `main.tsx`. It holds tokens, font faces and the Excalidraw theme, and styles no app element.
- Set `data-theme="light"` or `"dark"` on `<html>`; with neither, the OS decides. Pass the same resolved value to Excalidraw's `theme` prop.
- Colours use CSS `light-dark()`, so each pair sits on one line. It needs Chromium 123, Safari 17.5 or Firefox 120. Check this if a desktop wrapper uses an older webview.
- Use token names, never raw values. Add a token before adding a one-off.

| Need | Token |
| --- | --- |
| The workspace, behind the Storyboard and around the panels | `--page` |
| The chrome: header, panels, chat, dialogs, menus | `--surface`, edged with `--line` (`--border`) |
| Hover, the pager, a quiet fill | `--surface-sunken` (`--surface-hover` on top of it) |
| Hovered card, input edge, dashed slot | `--line-strong` |
| Canvas, thumbnails, the Lienzo's step strip | `--paper` |
| What you type into inside a panel (the chat's composer) | `--surface-raised` |
| Send and stop in the chat, the chosen view, the open step's number | `--accent` (= `--ink`) fill with `--on-accent` |
| Text | `--ink`, then `--ink-2`, then `--ink-3`; all pass AA on the page and on surfaces |
| Icons, disabled text | `--muted` (below AA for text) |
| Selected thing | `--accent-soft` fill, `--accent-line` edge, `--accent-ink` text |
| Primary action (Presentar) | `--accent` (= `--ink`) fill with `--on-accent` text, a little lighter on hover |
| Storyboard cards and lines | `--work-surface`, `--work-line`, and their sunken and strong variants |
| Agent's change | `--agent` fill with `--on-agent` text; `--agent-ink` if there is no fill |
| Saved | a 6px `--ok` dot before «Guardado» |
| Errors | `--danger-ink` on `--danger-soft` |
| Keyboard focus | `box-shadow: var(--focus-ring)` on `:focus-visible` |
| Lift | `--shadow-sm` (cards), `--shadow-md` (hover, the view selector, the floating panels), `--shadow-lg` (popovers, dialogs, the chat drawer) |

**Radii:** `--radius-panel` 20px (the floating projects and chat), `--radius-sm` 6px (badges, small controls, carousel thumbnails), `--radius-md` 8px (buttons, inputs, menu items, project tiles), `--radius-card` 10px (step cards, Excalidraw islands), `--radius-lg` 14px (dialogs, the chat's bubbles and composer). Pills (`--radius-pill`) are only for the agent chip, the view selector and the chat's send button.

**Type scale:** 11px for the spaced uppercase eyebrow only, 12px meta, 13px default, 15px, 20px for scene and dialog titles, 28px for the project title. Weights 400, 500, 600 and 700. Titles use `--tracking-title` (-0.02em); eyebrows use `--tracking-eyebrow` (0.16em).

**Focus:** a warm grey ring (`--focus`, `#7a7060`), a 3px band 2px outside the element. It reaches 3:1 on every layer.

## Component rules

**Header.** A paper bar across the window, under a thin line. Its first row is a three-column grid with equal outer columns, so the view selector sits on the window's true centre in both views. Left: the «Paso.» mark (an ink tile with Paso's step glyph, then the name), a divider and the projects toggle. Right: on the Lienzo, «Guardado» with its dot, then the agent status, then Presentar; on the Storyboard, the agent status and Presentar's reserved slot, or the `Agente` toggle on a narrow window.

On the Lienzo the header has a **second row**: the scene selector (a bordered button with the scene's number and name), then «PASO 03» as an eyebrow and the step's title. The title is where a step is named: a field that reads as text (a quiet fill on hover, «Añade un título» when empty) and becomes a bordered field while typing. Enter or leaving it keeps the title, Escape puts the last one back, and clearing it removes the title. It saves with the drawing, so «Guardado» covers it.

**Selector (Storyboard/Lienzo).** A paper capsule with a thin line and a soft shadow. The selected option is an inverted pill: `--ink` with `--on-ink` text. It is a `role="radiogroup"`, moved with the arrow keys.

**Projects.** A paper card floating on the left, 232px wide inside an 8px gutter, with 20px corners. «PROYECTOS» is an eyebrow. Each project is a 34px icon tile, its name and its size (`4 escenas · 17 pasos`). The current project has a warm grey row with a darker edge, and its tile is solid ink. Clicking the tile opens the icon picker. The footer says «Guardado en este equipo» after a green dot.

**Storyboard.** Under the header, on the white workspace:
- The project: the title at 28px and its size, with no eyebrow above. «Nueva escena» is a bordered secondary button on the right.
- Each scene sits under a thin rule: the eyebrow «ESCENA 2 DE 3», the title at 20px, and the step count in a small bordered counter. The drag handle and menu appear on hover or focus.
- Steps are white cards in a grid (minimum 208px wide): the thumbnail on top, with the step number in a small bordered badge on its top-left corner, then the title. An untitled step reads «Sin título» in `--ink-3`; it is named in the Lienzo's second row.
- The last cell of every scene is the dashed «El siguiente paso» card, with a warm grey `+` tile. It is always shown.

**Thumbnails.**
- `--paper`, always 16:10. Every step of a scene exports with the same bounds: the thumbnails are a sequence, so content must not jump when the bounding box changes. An empty scene uses a 1000×625 camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. Never recolour a thumbnail by hand.
- Current step: a 2px ink edge and a solid ink number badge. Agent changed it: a pink `agente` chip after the title. Agent is changing it now: a 2px pink edge and a chip reading `cambiando…` (`agente…` in the carousel). Current and agent states can coexist; the pink edge wins and the ink edge goes outside it.
- In the carousel, which has no room for a title, the number sits under the thumbnail and the title goes in the tooltip.

**Lienzo.** The canvas and the carousel under it are one `--paper` card with 20px corners and a thin line, in an 8px gutter like the panels.

**Carousel.** A 108px white bar under a thin line (it keeps `--paper`, like the canvas), in normal flow below the Excalidraw container. It must never overlap the container. Frames are 104×65, and the strip's left edge lines up with Excalidraw's zoom controls above. Next come the pager «03 / 06» on a warm grey pill (current number in bold ink), then «Añadir paso» and «Duplicar paso», pinned right.

**Carousel behaviour.** The strip scrolls and keeps the open step in view; Añadir and Duplicar stay pinned. Both start from the open step and both put the new step right after it:
- *Añadir paso* copies the drawing (same element IDs) and starts without title or speaker notes, because it is a new beat.
- *Duplicar paso* is an exact copy, title and notes included.
- Arrow keys, Home and End move between steps while focus is in the strip. Alt and the arrows move the step; Delete asks before removing it; a thumbnail can also be dragged. A new canvas does not take focus from the keyboard while the strip is in use.
- Deleting the open step opens the next one, or the previous one when it was the last. Deleting the last step leaves an empty scene with *Añadir paso* ready.

**Agent chat.** As before IN-05: a paper card floating on the right of the Storyboard, 360px to start with its gutter, with 20px corners. Its head (the target, a scene or the whole project, and «Nueva conversación») has no rule under it: space separates.
- Its left edge is a separator the person drags to change the width, between 320px and 720px; the board always keeps 440px. A thin ink line marks the edge on hover and while dragging (`--focus` when it has keyboard focus, where the arrow keys move it). A double click goes back to 360px. The width is remembered in this browser, and the narrow drawer uses it too.
- The person's message: right-aligned, 80% maximum width, on `--surface-sunken`, 14px corners. No name or avatar.
- The agent's text: bare, on the panel. No bubble.
- Tool activity: one 26px row per tool, a 16px Lucide icon, muted detail after the label. The step number is a pink chip that jumps to that step.
- Before the first message the log is empty: the head already says what the agent receives, and the composer invites the request.
- Composer: a lighter card (`--surface-raised`) with a thin line, which takes the focus ring while its text has focus. Agent and model pickers are ghost controls in its footer. The round 32px ink button on the right sends, and becomes stop (still ink, never red) while the agent works.
- `Deshacer ejecución` is a ghost button in the meta line under each finished run, with its time and how many changes it covers. The undo dialog lists what will happen as plain text, then the warnings.
- On a narrow window the `Agente` toggle turns ink while the drawer is open, and the drawer is the same floating card over the board.
- Before the first message, adding a harness is asked once, in a notice in the panel.

On the Lienzo there is no panel, so the header shows who is changing which step, with `Detener`. Under 1160px only the chip and `Detener` remain. **Under 1100px** the Storyboard keeps no column for the panel: a bordered `Agente` button takes Presentar's slot and opens the panel as a drawer from the right edge, under the header; Escape or its close button hides it.

**Presentar.** The drawing fills the screen on `--paper`. A minimal frame floats over it: the «Paso.» mark top left and «Salir Esc» top right; the step's title bottom left, «← → para navegar» bottom right. All of this fades out with the pointer, after two seconds. The pager stays: centred at the bottom on a warm grey pill, with ticks (ink for the current step) and «03 / 06». «Salir» is reached with the mouse; Esc stays the keyboard's way out, because Tab is kept from wandering to the app underneath.
- One camera per scene, from the union of all its steps and the screen (`present/framing.ts`), so whatever stays still between steps stays still on screen. Margins are 5% and 6% of the screen, never less than 32px and 48px. A scene under 480×300 is framed as if it were that size, so a small sketch is not blown up to the edges.
- A step with its own canvas colour fills the screen with it, through the same dark filter as its drawing.
- Above 24 steps, or under 480px wide, the pager drops the ticks and keeps the numbers.

**Dialogs and menus.** Dialogs are paper, 14px radius, with a large shadow over a dim scrim. They have a 20px title and the actions on the right under a thin rule; the destructive action is red text on a pale red fill. Menus and popovers are paper cards with a thin line and a large shadow. Items have 6px radius and a warm grey hover, and a checked item has a warm grey fill.

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
- **Theme.** `tokens.css` maps Excalidraw's primary colours to Paso's ink, its islands and corner buttons to paper cards with a thin line, and its UI font to Inter. One variable drives both the active tool and all selected options in the properties panel: the warm grey fill (`--accent-soft`) with ink, so a panel full of selected options stays calm.
- **Selection colour.** `--color-selection` goes straight to the canvas, which rejects `light-dark()` and silently draws black, so each theme sets a literal: `#7a7060` (the focus grey) in light, and `#5f574b` in dark. The dark canvas runs through Excalidraw's filter, which turns `#5f574b` into about `#a7a096`.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs: «Exportar imagen», then a «Preferencias» group, then «Fondo del lienzo».
- **Preferencias.** 0.18.1 has no preferences submenu, so Paso builds the group itself: «Mostrar cuadrícula», «Modo zen» and «Modo vista» as check items (`menuitemcheckbox`) with Excalidraw's own shortcuts, then «Tema» with Claro, Oscuro and Sistema. The grid is saved with each step, as Excalidraw saves it with a drawing. Zen and view mode are how the person is looking, so they carry over to the next step and are not saved. «Modo vista» avoids es-ES's «Modo presentación», which would be confused with Presentar.
- **Tema.** The theme row reuses Excalidraw's radio row markup with Paso's own Spanish labels (its built-in row says «Theme» in es-ES). The choice sets `data-theme` on `<html>` for the whole window and is remembered in this browser; «Sistema» removes it and the OS decides. Excalidraw's Alt+Shift+D also switches the whole window.
- **Untranslated text.** With `es-ES`, the hint has an English flowchart fragment. The Lienzo hides `.HintViewer`.
- **Keyboard.** Digits 1–9 and 0 pick tools, and arrows and PageUp/PageDown are also taken. Never bind bare keys for steps while the canvas has focus.

## What to avoid

- Translucency, blur and glass. The warm neutrals are solid colours.
- Cool greys or blues anywhere in the chrome: every neutral is warm paper. Mixing temperatures is what made the earlier palettes look unrelated.
- A floating card next to an edge-to-edge area, and scrollbar tracks: both draw stray stripes along the gutters. Scrolling areas use a thin thumb with no track.
- More colours in the chrome. Pink is the only hue; green appears only as the saved dot, and red only for errors and destructive actions.
- Pink for anything but the agent's work, or ink for the agent's. Each has one meaning.
- Heavy shadows on things that rest on the page. Cards get `--shadow-sm` at most; lift is for hover and for what floats.
- Cards inside cards. Use a thin line or space.
- Sketchy or hand-drawn styling in the chrome.
- Overlays on the canvas beyond Excalidraw's own. New controls go in the header or the carousel, or inside Excalidraw through `renderTopRightUI`.
- Text below 12px, except the uppercase eyebrow.
- Absolutely placed elements, such as visually hidden live regions, inside a scroll container that is not positioned. Their containing block becomes the window, and they make the whole document scroll. `.board` is `position: relative` for this reason.
