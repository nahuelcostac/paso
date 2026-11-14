# Paso: visual direction

Tokens are in `apps/web/src/styles/tokens.css`. Screenshots of the app are in `screens/`, and side-by-side comparisons with the older app this look comes from are in `compare/`.

## The idea: neutral greys and ink

The layout and type come from an earlier version of Paso (IN-05), and the floating panels and the chat from the Paso just before it. The colours are one family: layers of plain neutral grey, with no tint, written on in ink, with pink as the only hue. The board is the only pure white, so the drawings and their colours stand out. It replaced an earlier warm paper palette (beige), which competed with the drawings.

- **Layers of one paper.** The workspace behind the Estudio is an off-white (`#fafafa`). The chrome (the sidebar, the rails, the chat, dialogs and menus) is one tone deeper (`#f6f6f7`), with thin grey lines (`#e5e5e8`) and soft neutral shadows. Step cards and what you type into are plain white (the `--work-*` tokens, swapped in on `.board`). The sidebar is docked to the left; the chat is a card that floats with an 8px gutter and 20px corners. Everything is solid: no translucency or blur.
- **Drawings are the paper.** In the Lienzo the canvas and its step strip are one white surface filling everything right of the sidebar. Thumbnails sit at the top of the white step cards.
- **Ink is the accent.** `--accent` is `--ink`. The near-black (`#18181b`) marks actions (Presentar, the chat's send button, the button that creates a project's first scene), the chosen view, the open step (an ink edge and number) and the current project (an ink tile on a grey row). A selected option is a grey fill (`--accent-soft`). Focus is a grey ring.
- **One marker, pink `--agent`.** Whatever the agent touched gets a pink fill behind dark text, and the step it is changing right now gets a pink edge. It is the only hue in the chrome: ink means *you are here* or *do this*, pink means *the agent did this*. Anyone should be able to scan a board and find the agent's work.
- **Dark theme** mirrors the layers: the workspace is the deepest near-black (`#111113`), cards a step up (`#1a1a1d`) and the chrome another (`#1e1e21`), with light ink as the accent and the same pink. Both themes are complete. Neither is derived from the other at runtime.

Excalidraw's own controls are white cards with thin lines and ink, like the step cards, so the app reads as one object. The hand-drawn look stays inside drawings: no sketchy borders and no Excalifont in the chrome.

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
| The chrome: sidebar, rails, chat, dialogs, menus | `--surface`, edged with `--line` (`--border`) |
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
| Lift | `--shadow-sm` (cards), `--shadow-md` (hover, the floating panels), `--shadow-lg` (popovers, dialogs, the chat drawer) |

**Radii:** `--radius-panel` 20px (the chat's drawer), `--radius-sm` 6px (badges, small controls, carousel thumbnails), `--radius-md` 8px (buttons, inputs, menu items, project tiles), `--radius-card` 10px (step cards, Excalidraw islands), `--radius-lg` 14px (dialogs, the chat's bubbles and composer). Pills (`--radius-pill`) are only for the agent chip, the view selector and the chat's send button.

**Type scale:** 11px for the spaced uppercase eyebrow only, 12px meta, 13px default, 15px, 20px for scene and dialog titles, 28px for the project title. Weights 400, 500, 600 and 700. Titles use `--tracking-title` (-0.02em); eyebrows use `--tracking-eyebrow` (0.16em).

**Focus:** a grey ring (`--focus`, `#71717a`), a 3px band 2px outside the element. It reaches 3:1 on every layer.

## Component rules

**The board is the place.** A diagram (a project in the files) opens on the Lienzo, on the step where it was left in this browser, or else on its first step. Scenes are its pages, as in tldraw, listed under the diagram in the sidebar. The Storyboard is the Estudio: it shows the scene selected in the sidebar, its steps as cards, beside the chat that works on that scene. A two-way switch, «Lienzo | Estudio», sits under Presentar in the same top right corner of both views, so going and coming back is the same gesture and the open view is always shown; Escape or a click on a step also goes back to the Lienzo. The switch is not in the sidebar: the sidebar chooses what is open, the corner chooses how it is shown. In the interface a project is always a «diagrama».

**No header.** Nothing runs across the top of the window. The board fills everything right of the sidebar, edge to edge. The sidebar and, in the Estudio, the agent each fold into a 52px rail (`--rail-w`) on the chrome's paper, edged with a thin line. Folding and the width work as in Overleaf: on the line between each side and the board, at the middle of the window, a small white tab (16×40, `--radius-sm`, a thin line) carries a chevron that points the way the side goes, «Ocultar …» into it and «Mostrar …» out of it. That edge is also a separator the person drags to change the side's width, remembered in this browser: the sidebar from 200px to 420px (240px at first), the chat as below. Dragging it more than 80px past the narrowest width folds the side, and dragging a folded side's edge out opens it again. A thin ink line marks the edge on hover and while dragging (`--focus` with keyboard focus, where the arrow keys move it, Home and End go to the ends, Enter folds and unfolds); a double click goes back to the starting width. Over the content on a narrow window there is only the tab, and the sidebar or the chat's drawer has its own «Cerrar». The left rail has the ink mark and «Nuevo proyecto». The right rail has the agent's mark and, while the agent works with the panel folded, a pulsing pink dot, the step it is changing as a pink chip, and «Detener». The agent lives in the Estudio only: on the board it would read as working on the open step. It docks while the Estudio keeps 440px; otherwise it stays folded and opens as a drawer.

**Presentar** sits over the canvas's top right corner, 16px in, where Excalidraw's library button was: the ink button at 36px, the height of Excalidraw's islands. The «Lienzo | Estudio» switch sits under it: a white island with a thin line, the open view a grey fill with ink, and Presentar is as wide. The Estudio has the same corner, over its top right, so the switch never moves. On a board under 860px (an Estudio under 520px) both keep only their icons, so they never meet the centred toolbar. Why Presentar could not start appears to its left. The library opens from Excalidraw's main menu («Biblioteca»).

**Scenes in the sidebar.** The open diagram's scenes hang under its row, like tldraw's pages: a thin line on their left, a 30px row each with its number in `--ink-3` and its name, the open scene on `--accent-soft` with its name in semibold. A click opens the scene on the board; in the Estudio it selects the scene in place, and the Estudio and the chat follow it. A ⋮ on hover or focus has «Renombrar» (in place), «Mover a…» and «Eliminar…», which asks first. A scene changes place by dragging it: a 2px accent line above or below the scene it would land next to, by the half of the row the pointer is on. «Añadir diagrama» closes the list (it adds a scene). Other diagrams stay folded. With the sidebar folded, scenes are reached from the overview.

**Sidebar.** The diagrams, laid out like tldraw's sidebar. A `--surface` column docked to the left, 240px wide, the full height of the window, with a thin line on its right. At its head is the «Paso.» mark and the button that folds it into its rail. Then:
- The workspace switcher: the workspace's name in bold with a chevron. Its menu lists the workspaces, the open one checked and a missing folder marked «No disponible», then «Nuevo workspace…», «Abrir carpeta» and, for a folder the person added, «Quitar de la lista».
- «Buscar…» and «Nuevo proyecto», 34px rows with an icon, between thin rules. «Nuevo proyecto» asks for a name and opens the new diagram on the board, with its first scene and one empty step. «Buscar…» turns into a field that filters the list in place; Escape gives the row back.
- The diagrams grouped by when they last changed: «Hoy», «Este mes», «Anteriores», with the group's name in 12px `--ink-3`. One 34px line per diagram: its 16px icon (which opens the icon picker), then its name. The open diagram has a `--accent-soft` fill and its name in semibold ink. A ⋮ button appears on hover or focus. Diagrams that cannot be read go last, under «No se pueden abrir».
- The footer says how the open step is saved: «Guardado en este equipo» after a green dot, «Guardando…» or «Cambios pendientes» after a grey one, «Sin guardar» in red. Failures with no place of their own («Revisar paso sin guardar», a scene action that failed) sit above it; with the sidebar folded, above the step strip.
- Under 1064px the sidebar opens over the content, 280px wide with a large shadow, over a scrim that closes it; choosing a diagram closes it too.

**Nuevo workspace.** A dialog with a folder explorer served by the local service: a bar with the home folder, «Subir un nivel» and the path as steps (a long path keeps its end in view), a list of folders on `--surface-raised` where a click goes into a folder, then «Nueva carpeta» and how many projects the folder holds. «Usar esta carpeta» is the ink button. It opens beside the open workspace, or in the home folder.

**Storyboard (Estudio).** One scene, the one selected in the sidebar, on the white workspace. The sidebar renames, moves and deletes scenes, so the scene's header has no tools:
- Presentar and the «Lienzo | Estudio» switch in the top right corner, as on the board; the title keeps clear of them.
- Steps are named here: a click on a card's title (a pencil shows on hover) or F2 on the card opens a field over the label; Enter or leaving it saves, Escape gives up. The rest of the card opens the step on the Lienzo. A step open in this window is named through its own unsaved session, so nothing drawn is lost. The agent can name steps too.
- The diagram: the title at 28px and its size, with no eyebrow above.
- Each scene sits under a thin rule: the eyebrow «ESCENA 2 DE 3», the title at 20px, and the step count in a small bordered counter. The drag handle and menu appear on hover or focus.
- Steps are white cards in a grid (minimum 208px wide): the thumbnail on top, with the step number in a small bordered badge on its top-left corner, then the title. An untitled step reads «Sin título» in `--ink-3`.
- The last cell of every scene is the dashed «El siguiente paso» card, with a grey `+` tile. It is always shown.

**Thumbnails.**
- `--paper`, always 16:10. Every step of a scene exports with the same bounds: the thumbnails are a sequence, so content must not jump when the bounding box changes. An empty scene uses a 1000×625 camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. Never recolour a thumbnail by hand.
- Current step: a 2px ink edge and a solid ink number badge. Agent changed it: a pink `agente` chip after the title. Agent is changing it now: a 2px pink edge and a chip reading `cambiando…` (`agente…` in the carousel). Current and agent states can coexist; the pink edge wins and the ink edge goes outside it.
- In the carousel, which has no room for a title, the number sits under the thumbnail and the title goes in the tooltip.

**Lienzo.** The canvas and the carousel under it fill the space right of the sidebar, edge to edge, on `--paper`: no card, no gutter.

**Camera on the Lienzo.** The camera belongs to the scene, not the step. Opening a scene fits the union of all its steps (the frame Presentar uses), capped at 100%, in the clear area between Excalidraw's controls. Moving to another step of the same scene keeps the camera as it is, including any pan or zoom the person made, so what stays still between steps stays still on screen. A new scene or diagram is framed again.

**Presentation camera of a step.** A step can say which part of the drawing Presentar zooms to (`camera` in the step file, see `docs/data-format.md`). On the Lienzo, «Encuadrar» sits under the «Lienzo | Estudio» switch, a white island like it. It opens a drawing mode: a crosshair layer over the canvas with an ink hint on top («Arrastra para marcar lo que mostrará la presentación · Intro: usar lo que ves · Esc: cancelar»). A drag marks the box (at least 40px); a click or Enter takes what the canvas shows, without the strips under Excalidraw's controls; Escape gives up. With a camera set the button reads «Reencuadrar» and a cross beside it («Quitar encuadre») removes it. The camera is drawn over the canvas as a dashed box with an ink tag, «Encuadre de la presentación»: the tag and the dashed edges move it, eight white handles with an ink edge resize it, and the inside stays free for editing the drawing. In the Estudio a card with a camera has a small bordered badge on its drawing's top-right corner; the thumbnail still shows the whole scene. In Presentar, reaching a step with a camera glides to it in 750ms; leaving it for a step without one glides back to the whole scene. The box fills the screen inside the usual margins, never zooms out past the scene's framing and never past 6×, and the screen stays covered. «0» goes back to the step's camera. The agent sets and removes cameras with `update_step`.

**Keys on the Lienzo.** As in Presentar, ← → (and Page Up, Page Down) on the canvas go to the previous or next step of the scene, stopping at both ends. They stay the drawing's while something is selected, drawn or edited (they nudge it), in fields, menus and dialogs, and with any modifier. Space stays Excalidraw's pan. In the carousel the arrows keep their own behaviour (Alt and arrows move the step).

**Carousel.** A 108px white bar under a thin line (it keeps `--paper`, like the canvas), in normal flow below the Excalidraw container. It must never overlap the container. Frames are 104×65, and the strip's left edge lines up with Excalidraw's zoom controls above. Next comes the pager «03 / 06» on a grey pill (current number in bold ink), for the eye only. A compact + button follows the final thumbnail inside the scrolling strip. Each thumbnail shows duplicate and delete buttons together on hover or focus.

**Carousel behaviour.** The strip scrolls and keeps the open step in view. The + appends a step at the end. Duplicate acts on its own thumbnail and inserts the copy right after it, including when another step is open:
- *Añadir paso* copies the final step's drawing (same element IDs) and starts without title or speaker notes, because it is a new beat.
- *Duplicar paso* is an exact copy, title and notes included.
- Arrow keys, Home and End move between steps while focus is in the strip. Alt and the arrows move the step; Delete asks before removing it; a thumbnail can also be dragged. A new canvas does not take focus from the keyboard while the strip is in use.
- Deleting the open step opens the next one, or the previous one when it was the last. Deleting the last step leaves an empty scene with *Añadir paso* ready.

**Agent chat.** A column on the right of the Estudio, 360px to start, flush with the window's edges like the sidebar: the chrome's grey, square corners and a thin line on its left. As a drawer on a narrow window it floats instead, with 20px corners. Its head names the scene the agent works on, the one selected in the sidebar (or the whole diagram while it has no scenes); there is nothing to pick there. Then «Historial de conversaciones» and «Nueva conversación» (and «Cerrar» as a drawer). No rule under it: space separates.
- Its left edge is the splitter described under «No header»: its tab folds the chat, and a drag changes the width between 320px and 720px; the board always keeps 440px, and a wider sidebar leaves the chat less. A double click goes back to 360px. The width is remembered in this browser, and the narrow drawer uses it too.
- The person's message: right-aligned, 80% maximum width, on `--surface-sunken`, 14px corners. No name or avatar.
- The agent's text: bare, on the panel. No bubble.
- Tool activity: one 26px row per tool, a 16px Lucide icon, muted detail after the label. The step number is a pink chip that jumps to that step.
- Before the first message the log is empty: the head already says what the agent receives, and the composer invites the request.
- History: a popover under its button with the scene's conversations, newest first. Each is a row with its first message (one line, semibold) and, below in `--ink-3`, the agent, the model when it is not the default, how many messages and when («hoy, 14:05», «ayer, 09:12», «3 nov»). The open one is on `--accent-soft`. A click reopens it with all its messages, and the next message continues it. A bin on hover or focus deletes it after a dialog that says its messages and the agent's own copy on this computer go too, while what it changed in the diagram stays. A conversation that is running cannot be deleted.
- Composer: a lighter card (`--surface-raised`) with a thin line, which takes the focus ring while its text has focus. Its footer has one ghost control for agent, model and reasoning, after T3 Code's: the agent's own mark at 16px (Claude's orange, OpenAI's in ink, Antigravity's app icon; bundled, see `apps/web/src/assets/providers/NOTICE.md`), the model's name and the reasoning as rising bars filled up to the chosen level («Máximo» is named; automatic draws nothing). It opens a popup in three columns: a 48px rail with the agents' marks at 20px (the one in view on `--accent-soft`, the others faded), the models of the agent in view under a header with its name and version, and a sunken 164px column with the reasoning levels under «Razonamiento» and the model's name. An agent that is not installed or not usable yet shows why, with «Detectar de nuevo», instead of models. Picking a model keeps the popup open with the focus on the levels; picking a level closes it. Arrow keys move within a column and between columns. A different agent or model starts a new conversation; a level applies from the next message. The round 32px ink button on the right sends, and becomes stop (still ink, never red) while the agent works.
- `Deshacer ejecución` is a ghost button in the meta line under each finished run, with its time and how many changes it covers. The undo dialog lists what will happen as plain text, then the warnings.
- The tab on its edge folds it into its rail, as the sidebar's does on the left. With no room to dock, the tab opens the same panel as a floating drawer over the board.
- Before the first message, adding a harness is asked once, in a notice in the panel.

With the panel folded, its rail shows who is changing which step, with `Detener`. As a drawer, Escape or its close button folds it again.

**Presentar.** The drawing fills the screen on `--paper`. A minimal frame floats over it: the «Paso.» mark top left and «Salir Esc» top right; the step's title bottom left, the keys bottom right («← → pasos · mantén pulsado: láser · + − zoom», and the zoom level with «0 vuelve» while zoomed). All of this fades out with the pointer, after two seconds. The pager stays: centred at the bottom on a grey pill, with ticks (ink for the current step) and «03 / 06», between first and previous on its left and next and last on its right. Those four buttons fade with the frame, are disabled at the ends, and a click on them moves only once. «Salir» is reached with the mouse; Esc stays the keyboard's way out, because Tab is kept from wandering to the app underneath.
- One camera per scene, from the union of all its steps and the screen (`present/framing.ts`), so whatever stays still between steps stays still on screen. Margins are 5% and 6% of the screen, never less than 32px and 48px. A scene under 480×300 is framed as if it were that size, so a small sketch is not blown up to the edges.
- A step with its own canvas colour fills the screen with it, through the same dark filter as its drawing.
- Above 24 steps, or under 480px wide, the pager drops the ticks and keeps the numbers.
- Manual navigation uses the board gestures. A trackpad pinch or Ctrl/Cmd + wheel zooms around the pointer with Excalidraw's response and 0.1–30× limits relative to the opening frame. Two-finger scrolling or the wheel pans, Shift + wheel pans horizontally, and Space + drag or the middle mouse button pans freely. Space no longer advances a step, and releasing a drag never changes the step. + and − change zoom by 0.1; 0 restores the step's saved camera, or the scene frame. Direct gestures have no transition delay. Manual navigation stays between steps without a saved camera. The laser is the Lienzo's: Excalidraw's laser cursor over the drawing, and while the pointer is held its red trail (`@excalidraw/laser-pointer`, with the options of Excalidraw 0.18.1), which fades within a second of the release; a press or click never changes the step, which only the pager and the keys do. Ctrl/Cmd with + and − stays the browser's zoom.

**Dialogs and menus.** Dialogs are paper, 14px radius, with a large shadow over a dim scrim. They have a 20px title and the actions on the right under a thin rule; the destructive action is red text on a pale red fill. Menus and popovers are paper cards with a thin line and a large shadow. Items have 6px radius and a grey hover, and a checked item has a grey fill.

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

- **Width.** Keep the container at 744px or wider (`--canvas-min-w`): below 730px Excalidraw switches to its mobile layout and moves the toolbar. The agent folds when docking it would take the board under 760px, and the sidebar opens over the board under a 1064px window. The library button is hidden; Presentar takes its corner.
- **Height.** The properties panel shrinks and scrolls with its container, ending 38px above the zoom controls. Re-measured with the two-row header and the carousel in a 1280×720 window (IN-05).
- **Offline.** By default Excalifont loads from `esm.sh`. Set `window.EXCALIDRAW_ASSET_PATH` and serve a copy of the package's `dist/prod/fonts`. Verified: no external requests with this set.
- **Vite.** Add `define: { 'process.env.IS_PREACT': JSON.stringify('false') }`, or the component does not render.
- **Inherited type.** Excalidraw inherits `font-size` and `line-height`, and its panel spacing drifts if an ancestor sets them. Reset both on its wrapper: `font-size: 16px; line-height: normal`.
- **Text before fonts.** Text measured before Excalifont has loaded gets clipped on the canvas. Load the font before creating or converting text elements, which matters for agent-written scenes.
- **Theme.** `tokens.css` maps Excalidraw's primary colours to Paso's ink, its islands and corner buttons to white cards with a thin line (the `--work-*` tokens, swapped in on `.excalidraw`), and its UI font to Inter. One variable drives both the active tool and all selected options in the properties panel: the grey fill (`--accent-soft`) with ink, so a panel full of selected options stays calm.
- **Selection colour.** `--color-selection` goes straight to the canvas, which rejects `light-dark()` and silently draws black, so each theme sets a literal: `#7a7060` (the focus grey) in light, and `#5f574b` in dark. The dark canvas runs through Excalidraw's filter, which turns `#5f574b` into about `#a7a096`.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs: «Exportar imagen», then a «Preferencias» group, then «Fondo del lienzo».
- **Preferencias.** 0.18.1 has no preferences submenu, so Paso builds the group itself: «Mostrar cuadrícula», «Modo zen» and «Modo vista» as check items (`menuitemcheckbox`) with Excalidraw's own shortcuts, then «Tema» with Claro, Oscuro and Sistema. The grid is saved with each step, as Excalidraw saves it with a drawing. Zen and view mode are how the person is looking, so they carry over to the next step and are not saved. «Modo vista» avoids es-ES's «Modo presentación», which would be confused with Presentar.
- **Tema.** The theme row reuses Excalidraw's radio row markup with Paso's own Spanish labels (its built-in row says «Theme» in es-ES). The choice sets `data-theme` on `<html>` for the whole window and is remembered in this browser; «Sistema» removes it and the OS decides. Excalidraw's Alt+Shift+D also switches the whole window.
- **Untranslated text.** With `es-ES`, the hint has an English flowchart fragment. The Lienzo hides `.HintViewer`.
- **Keyboard.** Digits 1–9 and 0 pick tools, and arrows and PageUp/PageDown are also taken. Never bind bare keys for steps while the canvas has focus.

## What to avoid

- Translucency, blur and glass. The neutrals are solid colours.
- Tinted neutrals (warm beige or cool blue-grey) or a second accent hue in the chrome: every neutral is a plain grey. Mixing temperatures is what made earlier palettes look unrelated.
- A floating card next to an edge-to-edge area, and scrollbar tracks: both draw stray stripes along the gutters. Scrolling areas use a thin thumb with no track.
- More colours in the chrome. Pink is the only hue; green appears only as the saved dot, and red only for errors and destructive actions.
- Pink for anything but the agent's work, or ink for the agent's. Each has one meaning.
- Heavy shadows on things that rest on the page. Cards get `--shadow-sm` at most; lift is for hover and for what floats.
- Cards inside cards. Use a thin line or space.
- Sketchy or hand-drawn styling in the chrome.
- Overlays on the canvas beyond Excalidraw's own and Presentar, which takes the library button's corner. New controls go in the sidebar, the step strip, a rail, or Excalidraw's main menu.
- Text below 12px, except the uppercase eyebrow.
- Absolutely placed elements, such as visually hidden live regions, inside a scroll container that is not positioned. Their containing block becomes the window, and they make the whole document scroll. `.board` is `position: relative` for this reason.
