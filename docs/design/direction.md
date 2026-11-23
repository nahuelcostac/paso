# Paso: visual direction

Tokens are in `apps/web/src/styles/tokens.css`. Screenshots of the app are in `screens/`, and side-by-side comparisons with the older app this look comes from are in `compare/`.

## The idea: neutral greys and ink

The layout and type come from an earlier version of Paso (IN-05), and the floating panels and the chat from the Paso just before it. The colours are one family: layers of plain neutral grey, with no tint, written on in ink, with pink as the only hue. The board is the only pure white, so the drawings and their colours stand out. It replaced an earlier warm paper palette (beige), which competed with the drawings.

- **Layers of one paper.** The workspace behind the Studio is an off-white (`#fafafa`). The chrome (the sidebar, the rails, the chat, dialogs and menus) is one tone deeper (`#f6f6f7`), with thin grey lines (`#e5e5e8`) and soft neutral shadows. Step cards and what you type into are plain white (the `--work-*` tokens, swapped in on `.board`). The sidebar is docked to the left; the chat is a card that floats with an 8px gutter and 20px corners. Everything is solid: no translucency or blur.
- **Drawings are the paper.** On the Canvas the canvas and its step strip are one white surface filling everything right of the sidebar. Thumbnails sit at the top of the white step cards.
- **Ink is the accent.** `--accent` is `--ink`. The near-black (`#18181b`) marks actions (Present, the chat's send button, the button that creates a project's first scene), the chosen view, the open step (an ink edge and number) and the current project (an ink tile on a grey row). A selected option is a grey fill (`--accent-soft`). Focus is a grey ring.
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
| Canvas, thumbnails, the Canvas view's step strip | `--paper` |
| What you type into inside a panel (the chat's composer) | `--surface-raised` |
| Send and stop in the chat, the chosen view, the open step's number | `--accent` (= `--ink`) fill with `--on-accent` |
| Text | `--ink`, then `--ink-2`, then `--ink-3`; all pass AA on the page and on surfaces |
| Icons, disabled text | `--muted` (below AA for text) |
| Selected thing | `--accent-soft` fill, `--accent-line` edge, `--accent-ink` text |
| Primary action (Present) | `--accent` (= `--ink`) fill with `--on-accent` text, a little lighter on hover |
| Storyboard cards and lines | `--work-surface`, `--work-line`, and their sunken and strong variants |
| Agent's change | `--agent` fill with `--on-agent` text; `--agent-ink` if there is no fill |
| Saved | a 6px `--ok` dot before “Saved” |
| Errors | `--danger-ink` on `--danger-soft` |
| Keyboard focus | `box-shadow: var(--focus-ring)` on `:focus-visible` |
| Lift | `--shadow-sm` (cards), `--shadow-md` (hover, the floating panels), `--shadow-lg` (popovers, dialogs, the chat drawer) |

**Radii:** after T3 Code, whose `--radius` is 8px. `--radius-sm` 4px (menu items, badges, inline fields, carousel thumbnails; T3 Code's `rounded-sm`), `--radius-md` 8px (buttons, fields, sidebar rows, menus and popovers; its `--control-radius`), `--radius-card` 10px (step cards, Excalidraw islands), `--radius-lg` 16px (dialogs, the chat's bubbles and composer; its `rounded-2xl`), `--radius-panel` 20px (the chat's drawer). Pills (`--radius-pill`) are only for the agent chip, the view selector and the chat's send button.

**Type scale:** T3 Code's at its 16px root: 14px default (`--text-14`, its `text-sm`: buttons, fields, menu items, sidebar rows, the agent conversation), 12px meta (`text-xs`), 11px for the spaced uppercase eyebrow only, 15px for the mark's name, 20px for scene and dialog titles, 28px for the project title. Weights 400, 500, 600 and 700; controls are 500, as there. Titles use `--tracking-title` (-0.02em); eyebrows use `--tracking-eyebrow` (0.16em).

**Icons:** Lucide at 16px (`--icon`, T3 Code's `size-4`), 14px in 24px controls, with T3 Code's lighter stroke of 1.75 (`--icon-stroke`).

**Focus:** a grey ring (`--focus`, `#71717a`), a 3px band 2px outside the element. It reaches 3:1 on every layer. It stays Paso's own: T3 Code's 2px inset ring in its blue would be a second hue in the chrome.

## Controls: measured from T3 Code

Taken from T3 Code's source (`github.com/pingdotgg/t3code`, `apps/web/src/components/ui/` and `index.css`) and checked against the installed app's bundle (T3 Code (Beta), `app.asar`). T3 Code's sizes are its desktop ones (`sm:` and up).

| Control | Paso | T3 Code source |
| --- | --- | --- |
| Button | 32px (`--control-h`), 12px in, 8px corners, 14px weight 500, 16px icon 8px from the text | `button.tsx` size `default`: `h-9 sm:h-8 px-[calc(--spacing(3)-1px)]` plus a 1px border, `gap-2 font-medium sm:text-sm`, `rounded-[var(--control-radius)]` |
| Small button (“Detect again”) | 28px (`--control-h-sm`), 10px in | size `sm`: `h-8 sm:h-7 px-[calc(--spacing(2.5)-1px)] gap-1.5` |
| Extra small button (a notice's action, “Undo run”) | 24px (`--control-h-xs`), 8px in, 12px | size `xs`: `h-7 sm:h-6 sm:text-xs` |
| Large button (empty states) | 36px (`--control-h-lg`), 14px in | size `lg`: `h-10 sm:h-9 px-[calc(--spacing(3.5)-1px)]` |
| Icon button | 32px square, 16px icon, `--ink-3` | size `icon`: `size-9 sm:size-8` |
| Ghost (`.btn`, `.icon-btn`) | no fill, `--surface-sunken` on hover | variant `ghost`: `border-transparent [:hover]:bg-accent` |
| Soft, the outlined secondary (`.btn--soft`) | `--surface-raised` fill, `--line-strong` edge, `--shadow-sm` | variant `outline`: `border-input bg-popover shadow-xs/5` |
| Primary (`.btn--primary`) | ink fill, `--on-ink`, `--shadow-sm`; 36px beside Excalidraw's islands | variant `default`: `bg-primary shadow-xs`, hover `bg-primary/90` |
| Pressed | scales to 0.97, except a button that opens a menu | `[&:active:not([aria-haspopup])]:scale-[0.97]` |
| Disabled | opacity 0.64 (`--disabled-opacity`) | `disabled:opacity-64` |
| Field (the icon picker's search) | 32px, 12px in, 8px corners, `--line-strong` edge on `--surface-raised` | `input.tsx`: `sm:h-7.5` plus a 1px border, `rounded-lg border-input` |
| Sidebar row (Search, a project) | 32px, 10px in, the icon 10px from the name, 4px apart, 14px weight 500 | `SidebarProjectFolderHeader.tsx`: `h-8 gap-2.5 px-(--sidebar-row-content-inset)` (10px), `text-sm font-medium`; `SidebarMenu` `gap-1` |
| Sidebar sub-row (a scene) | 28px (`--control-h-sm`), under a line 14px in, 10px past it, 4px apart | `SidebarMenuSub`: `mx-3.5 border-l px-2.5 gap-1`; `SidebarMenuSubButton`: `h-7 px-2 gap-2` |
| Row action (⋮) | 24px, 8px corners, 14px icon | `SidebarProjectFolderHeader.tsx` `size="icon-xs"`: `sm:size-6`, `sm:size-3.5` icon |
| Menu | 4px in, 8px corners, at least 160px | `menu.tsx` popup: `rounded-lg p-1 min-w-[min(10rem,…)]` |
| Menu item | 28px, 8px in, icon 8px from the label, 4px corners, 14px | `MenuItem`: `sm:min-h-7 px-2 gap-2 rounded-sm sm:text-sm` |
| Menu separator | a line 8px in, 4px above and below | `MenuSeparator`: `mx-2 my-1 h-px` |
| Dialog | 448px, 16px corners, 24px in, a 20px semibold title; the actions on a `--surface-sunken` band under a line, 16px above and below its 32px buttons | `dialog-styles.ts`: `rounded-2xl`; `dialog.tsx`: header `p-6`, title `font-semibold text-xl`, footer `border-t bg-muted/72 py-4 px-6 gap-2` |
| Composer | 16px corners; its controls 24px, 7px in, 12px text, 14px icons; send a 32px circle | `ChatComposer.tsx` `rounded-2xl`; `ComposerControl.tsx` `sm:h-6 px-1.75 sm:text-xs`; `ComposerPrimaryActions.tsx` `sm:size-8 rounded-full` |
| The person's message | 16px corners | `TimelineUserMessageRow.tsx` `rounded-2xl` |

Kept as Paso's own: the colours (neutral greys and ink, not T3 Code's blue primary or its translucent glass menus and dialogs: everything here is solid), Inter instead of the system font, the focus ring, the sidebar's 60px head and the fold toggles (aligned with T3 Code before), Excalidraw's controls and Paso's islands over the board, which keep Excalidraw's 36px.

## Component rules

**The board is the place.** A project opens on the Canvas, on the step where it was left in this browser, or else on its first step. Scenes are its pages, as in tldraw, listed under the project in the sidebar. The Storyboard is the Studio: it shows the scene selected in the sidebar, its steps as cards, beside the chat that works on that scene. A two-way switch, “Canvas | Studio”, sits under Present in the same top right corner of both views, so going and coming back is the same gesture and the open view is always shown; Escape or a click on a step also goes back to the Canvas. The switch is not in the sidebar: the sidebar chooses what is open, the corner chooses how it is shown. The interface uses the data model's own words: project, scene, step, and loose diagram (“diagram” for short) for a scene that belongs to no project.

**Language.** The interface is in English, with no language selector: sentence-case product English, and macOS's title-style capitals only in the native menu bar. Names and text the person wrote (projects, scenes, step titles, drawings) stay in whatever language they were written in; only new defaults, such as “Scene 2” or “My projects”, are English. The agents' instructions are in English and ask them to reply in the language of the person's message. The Canvas's address is `#/<project>/canvas/<scene>/<step>`; an address from before, with `lienzo` in its place, still opens and is rewritten to `canvas` without a history entry, so bookmarks keep working.

**No header.** Nothing runs across the top of the window. The board fills everything right of the sidebar, edge to edge. Each side shows and hides with one ghost button, as in Notion: Lucide `panel-left` for the sidebar, `panel-right` for the chat, 32px, in `--ink-3` with a grey fill on hover, named “Hide …” while the side shows and “Show …” while it is folded. Each button stays at one place on the page whether its side shows or not, so it never moves under the pointer. The sidebar's sits at the top left, centred on the sidebar's 60px head (12px in, or after the window's buttons in the desktop app on macOS); folded, the sidebar leaves nothing else, and the button stays there over the board, whose top left controls make room for it (the Studio's page starts under the button's row). The chat's sits at the right end of its head; folded, the chat leaves nothing, as in T3 Code, and the button stays at the same spot over the Studio, whose top right corner (Present and the view switch) moves 32px left to leave it room. A docked side's inner edge is a separator the person drags to change its width, remembered in this browser: the sidebar from 200px to 420px (240px at first), the chat as below. Dragging it more than 80px past the narrowest width folds the side. A thin ink line marks the edge on hover and while dragging (`--focus` with keyboard focus, where the arrow keys move it, Home and End go to the ends, Enter folds); a double click goes back to the starting width. On a narrow window the sidebar opens over the content and the chat as a drawer, and their buttons stay where they are, over them (the chat's lines up with the drawer's head). While the agent works with its panel folded, a small floating pill at the foot of the Studio, by the chat's button, shows a pulsing pink dot, the step it is changing as a pink chip, and “Stop”. The agent lives in the Studio only: on the board it would read as working on the open step. It docks while the Studio keeps 440px; otherwise it stays folded and opens as a drawer.

**Desktop window.** On macOS the desktop app has no title bar, as in Notion: close, minimise and zoom sit over the sidebar's head, 16px in, centred on it, and the sidebar's button follows them. The window moves by the sidebar's head, the chat's head, or the corner by its buttons while the sidebar is folded; never by the board, where the pointer draws. Present starts its mark after the window's buttons. On Windows and Linux the system's frame stays.

**Present** sits over the canvas's top right corner, 16px in, where Excalidraw's library button was: the ink button at 36px, the height of Excalidraw's islands. The “Canvas | Studio” switch sits under it: a white island with a thin line, the open view a grey fill with ink, and Present is as wide. The Studio has the same corner, over its top right, so the switch never moves. On a board under 860px (a Studio under 520px) both keep only their icons, so they never meet the centred toolbar. Why Present could not start appears to its left. The library opens from Excalidraw's main menu (“Library”).

**Excalidraw's main menu** (export, preferences, the library) sits right before its toolbar, 8px apart and centred on its height, the two centred on the board as one group. The selected shape's properties stay on the left, under the toolbar's row. The board's top left corner is the sidebar's button.

**Scenes in the sidebar.** The open project's scenes hang under its row, like tldraw's pages: a thin line on their left, a 28px row each with its number in `--ink-3` and its name, the open scene on `--accent-soft` with its name in semibold. A click opens the scene on the board; in the Studio it selects the scene in place, and the Studio and the chat follow it. A ⋮ on hover or focus has “Rename” (in place), “Move to…” and “Delete…”, which asks first. A scene changes place by dragging it: a 2px accent line above or below the scene it would land next to, by the half of the row the pointer is on. “Add scene” closes the list. Other projects stay folded. With the sidebar folded, scenes are reached from the overview.

**Sidebar.** The projects and loose diagrams, laid out like tldraw's sidebar. A `--surface` column docked to the left, 240px wide, the full height of the window, with a thin line on its right. Its 60px head holds the button that folds it (see “No header”), then the “Paso” mark, small as T3 Code's name: its tile as large as the button's 18px icon, and the name at 15px. Then:
- The workspace switcher: the workspace's name in bold with a chevron. Its menu lists the workspaces, the open one checked and a missing folder marked “Unavailable”, then “New workspace…”, “Open folder” and, for a folder the person added, “Remove from list”.
- The project filter, after T3 Code's: a 32px row under the switcher naming what the list shows, “All projects” (Lucide `list-filter`), one project (its icon) or “Loose diagrams” (`shapes`), with a small chevron. It opens a popover as T3 Code's does: a “Search projects…” field, then “All projects”, the projects in the sidebar's order and, after a thin rule, “Loose diagrams”; the chosen one is semibold with a check. The focus stays in the field (a combobox over a listbox): the arrow keys move the highlight, wrapping, Enter chooses, Escape and Tab close it and go back to the row. Searching ignores case and accents, leaves out “All projects” and says “No matching projects.” when nothing matches. With a project chosen the list shows only that project and its scenes; with “Loose diagrams”, only those (“No loose diagrams yet.” while there are none). “Search” then narrows what the filter shows. Choosing never opens anything. Each workspace remembers its own filter in the service's list of workspaces (`workspaces.json`), so the browser and the desktop app share it and it survives reopening either; the app then opens on what the filter shows. As in T3 Code, opening something the filter hides (a new project or diagram, a scene followed into another project) shows “All projects” again, and a filter whose project is gone falls back to “All projects” and is forgotten.
- One 32px row between thin rules, as in T3 Code: “Search” with its icon on the left, then “New project” (Lucide `folder-plus`) and “New diagram” (`square-pen`) as 32px icon buttons in `--ink-3`, named by their tooltips. “New project” asks for a name and opens the new project on the board, with its first scene and one empty step. “Search” turns into a field that filters the list in place, beside the two icons; Escape gives the row back.
- The projects grouped by when they last changed: “Today”, “This month”, “Earlier”, with the group's name in 12px `--ink-3`. One 32px line per project: its 16px icon (which opens the icon picker), then its name. The open project has a `--accent-soft` fill and its name in semibold ink. A ⋮ button appears on hover or focus. Projects that cannot be read go last, under “Can't be opened”. Loose diagrams follow, flat, with no heading.
- The sidebar has no save indicator: saving is silent, and only a failure speaks. The step on screen shows its own notice on the Canvas; failures with no place of their own (“Review unsaved step”, a scene action that failed) sit at the foot of the sidebar; with the sidebar folded, above the step strip.
- Under 1064px the sidebar opens over the content, 280px wide with a large shadow, over a scrim that closes it; choosing a project or diagram closes it too.

**New workspace.** A dialog with a folder explorer served by the local service: a bar with the home folder, “Up one level” and the path as steps (a long path keeps its end in view), a list of folders on `--surface-raised` where a click goes into a folder, then “New folder” and how many projects the folder holds. “Use this folder” is the ink button. It opens beside the open workspace, or in the home folder.

**Storyboard (Studio).** One scene, the one selected in the sidebar, on the white workspace. The sidebar renames, moves and deletes scenes, so the scene's header has no tools:
- Present and the “Canvas | Studio” switch in the top right corner, as on the board; the title keeps clear of them.
- Steps are named here: a click on a card's title (a pencil shows on hover) or F2 on the card opens a field over the label; Enter or leaving it saves, Escape gives up. The rest of the card opens the step on the Canvas. A step open in this window is named through its own unsaved session, so nothing drawn is lost. The agent can name steps too.
- The project: the title at 28px and its size, with no eyebrow above.
- Each scene sits under a thin rule: the eyebrow “SCENE 2 OF 3”, the title at 20px, and the step count in a small bordered counter. The drag handle and menu appear on hover or focus.
- Steps are white cards in a grid (minimum 208px wide): the thumbnail on top, with the step number in a small bordered badge on its top-left corner, then the title. An untitled step reads “Untitled” in `--ink-3`.
- The last cell of every scene is the dashed “The next step” card, with a grey `+` tile. It is always shown.

**Thumbnails.**
- `--paper`, always 16:10. Every step of a scene exports with the same bounds: the thumbnails are a sequence, so content must not jump when the bounding box changes. An empty scene uses a 1000×625 camera.
- Render with `exportToSvg` and `exportWithDarkMode` set to the current theme. Never recolour a thumbnail by hand.
- Current step: a 2px ink edge and a solid ink number badge. Agent changed it: a pink `agent` chip after the title. Agent is changing it now: a 2px pink edge and a chip reading `changing…` (`agent…` in the carousel). Current and agent states can coexist; the pink edge wins and the ink edge goes outside it.
- In the carousel, which has no room for a title, the number sits under the thumbnail and the title goes in the tooltip.

**Canvas.** The canvas and the carousel under it fill the space right of the sidebar, edge to edge, on `--paper`: no card, no gutter. Any diagram can hide the carousel (see “Step strip of a loose diagram”).

**Camera on the Canvas.** The camera belongs to the scene, not the step. Opening a scene fits the union of all its steps (the frame Present uses), capped at 100%, in the clear area between Excalidraw's controls. Moving to another step of the same scene keeps the camera as it is, including any pan or zoom the person made, so what stays still between steps stays still on screen. A new scene or project is framed again.

**Moving between steps on the Canvas.** As smooth as Present: the carousel, the keys and an agent's step change swap the drawing in one frame, with no “Loading drawing…” and no flicker. The Canvas keeps one Excalidraw per project and never mounts it again for another step: the next step is prepared beside the one on screen (the service reads it, its images and fonts load, its text is measured) while the current drawing stays, and then it replaces it in a single update (`step-swap.ts`). Images already read are kept in memory, so steps that share them wait for nothing. The step's own drawing, grid and background come with it, with an empty selection; the camera, the open sidebar, the tool (the laser too) and its styles stay as they are. The Canvas's controls, the presentation camera's box and the notices follow the step on screen, so they change with the drawing. The carousel marks the new step at once. Before the swap the drawing being left is handed to the store, so an edit Excalidraw had not reported yet is saved with that step. Undo is per step and starts empty on each one: it never reaches into another step, and Excalidraw's undo and redo buttons show it. A step reloaded from outside (an agent's change, “Undo run”, the service's copy after a conflict) swaps in the same way. Opening a project mounts Excalidraw; “Loading drawing…” (and “Loading editor…” before it) appears only if that takes more than 300ms.

**Presentation camera of a step.** A step can say which part of the drawing Present zooms to (`camera` in the step file, see `docs/data-format.md`). On the Canvas, “Frame” sits under the “Canvas | Studio” switch, a white island like it. It opens a drawing mode: a crosshair layer over the canvas with an ink hint on top (“Drag to mark what the presentation shows · Enter: use what you see · Esc: cancel”). A drag marks the box (at least 40px); a click or Enter takes what the canvas shows, without the strips under Excalidraw's controls; Escape gives up. With a camera set the button reads “Reframe” and a cross at the end of the island (“Remove framing”) removes it. The camera is drawn over the canvas as a dashed box with an ink tag, “Presentation framing”: the tag and the dashed edges move it, eight white handles with an ink edge resize it, and the inside stays free for editing the drawing. In the Studio a card with a camera has a small bordered badge on its drawing's top-right corner; the thumbnail still shows the whole scene. In Present, reaching a step with a camera glides to it in 750ms; leaving it for a step without one glides back to the whole scene. The box fills the screen inside the usual margins, never zooms out past the scene's framing and never past 6×, and the screen stays covered. “0” goes back to the step's camera. The agent sets and removes cameras with `update_step`.

**Keeping the previous step's camera.** A step can keep the camera of the step before it instead of having its own (`camera: "previous"`, see `docs/data-format.md`), so a run of steps that build up one area holds the frame. On the Canvas it is a square in the “Frame” island right after “Frame”, before the cross that removes an own camera: the corners of “Frame” (Lucide `scan`) around an arrow going back (`KeepCameraIcon`, drawn in Lucide's style), “Keep previous step's framing”, pressed on `--accent-soft` while on. Turning it on replaces an own camera, and marking one with “Frame” replaces the option; pressing it again leaves the step with no camera. The first step of a scene has nothing to keep, so it has no such button; only a first step that keeps it all the same (moved there, or set by an agent) shows it, pressed, to turn it off. The box it keeps is drawn over the canvas apart from an own one: dotted, not dashed, with no handles and nothing to drag, and an outlined paper tag instead of the ink one, “Framing of step 02”, with the same icon. The tag opens that step, where the box can be changed. While the step keeps a camera that shows the whole scene there is no box, and a note under the island says so, wrapped to the corner's width: “This is the first step: there's no framing to keep…” or “The previous step shows the whole scene, and so does this one.” In the Studio the card has the same badge with a dashed edge and that icon. In Present the step does not move when reached from a step that shows the same camera, not even a zoom made by hand; “0” goes back to the camera it keeps. It shows what the step before it shows, walking back past the steps that keep it too, and follows live when that camera changes. The link is by position: reordering changes what it keeps, deleting the step it comes from makes it walk further back, and a duplicate keeps the option.

**Keys on the Canvas.** As in Present, ← → (and Page Up, Page Down) on the canvas go to the previous or next step of the scene, stopping at both ends. They stay the drawing's while something is selected, drawn or edited (they nudge it), in fields, menus and dialogs, and with any modifier. Space stays Excalidraw's pan. In the carousel the arrows keep their own behaviour (Alt and arrows move the step).

**Carousel.** A white strip under a thin line (it keeps `--paper`, like the canvas), in normal flow below the Excalidraw container, with its bar under it. Neither ever overlaps the container. The strip is 100px over its bar (108px in a scene with no steps, which has no bar), with the thumbnails at its foot. Frames are 104×65, and the strip's left edge lines up with Excalidraw's zoom controls above. A compact + button follows the final thumbnail inside the scrolling strip. Each thumbnail shows duplicate and delete buttons together on hover or focus.

**Step bar.** A 36px paper band under the strip, with no line between them, which stays when the strip is hidden. In the middle, Present's pager without its pill: previous, “02 / 03” (the current number in bold ink) and next, 28px ghost buttons that are disabled at the ends. At the right, a 28px outlined square with a Lucide chevron and no text, which shows and hides the strip: `chevron-down` folds it, `chevron-up` brings it back. Its name says what it does (“Hide steps”, “Show steps”), as does its tooltip, and `aria-expanded` says whether the strip shows. While the strip is hidden, the bar's left holds the steps as ticks, as in Present (the current one longer, in ink), for the eye only; above 24 steps, or under 900px wide, it keeps the numbers alone. A single step has no pager, only the chevron.

**Carousel behaviour.** The strip scrolls and keeps the open step in view. The + appends a step at the end. Duplicate acts on its own thumbnail and inserts the copy right after it, including when another step is open:
- *Add step* copies the final step's drawing (same element IDs) and starts without title or speaker notes, because it is a new beat.
- *Duplicate step* is an exact copy, title and notes included.
- Arrow keys, Home and End move between steps while focus is in the strip. Alt and the arrows move the step; Delete asks before removing it; a thumbnail can also be dragged. A new canvas does not take focus from the keyboard while the strip is in use.
- Deleting the open step opens the next one, or the previous one when it was the last. Deleting the last step leaves an empty scene with *Add step* ready.

**Step strip of a loose diagram.** A loose diagram (“New diagram” in the sidebar) is usually one drawing, so it opens on the Canvas as a plain whiteboard: the strip is hidden, and only its bar stays at the foot. A diagram with more than one step shows the strip from the start, and one with no steps always shows it, since “Add step” is there.
- With one step (or none) it is a plain whiteboard in full: the Canvas has no top right corner (no Present, no Canvas | Studio switch, no Frame), and the agent's chat sits beside the Canvas, as it does beside the Studio elsewhere, with the same toggle to fold it. An address for its Studio opens the Canvas. A second step brings the corner back, and the chat returns to the Studio.
- Every diagram, loose or in a project, shows and hides its strip with the chevron at the right of the step bar. The bar keeps its height and place, so the chevron never moves under the pointer, and hiding the strip gives the canvas back all but the bar's 36px. Hiding the strip never touches the steps.
- The choice is remembered in this browser (`paso.loose-strip` in `localStorage`): per loose diagram, and per project for all its scenes. Without one, a project shows the strip and a loose diagram follows its number of steps. Toggling keeps the focus on the button and never mounts Excalidraw again.
- While the strip is hidden, ← → and Page Up, Page Down on the canvas still move between the steps, as in Present.
- A loose diagram moved into a project takes the project's choice, which shows the strip unless it was hidden there.

**Agent chat.** A column on the right of the Studio, 360px to start, flush with the window's edges like the sidebar: the chrome's grey, square corners and a thin line on its left. As a drawer on a narrow window it floats instead, with 20px corners. Its head names the scene the agent works on, the one selected in the sidebar (or the whole project while it has no scenes); there is nothing to pick there. Then “Conversation history” and “New conversation”, and at the right end the button that folds it (see “No header”), as a drawer too. No rule under it: space separates.
- Its left edge is the splitter described under “No header”: a drag changes the width between 320px and 720px; the board always keeps 440px, and a wider sidebar leaves the chat less. A double click goes back to 360px. The width is remembered in this browser, and the narrow drawer uses it too.
- The person's message: right-aligned, 80% maximum width, on `--surface-sunken`, 16px corners. No name or avatar.
- The agent's text: bare, on the panel. No bubble.
- Tool activity: one 26px row per tool, a 16px Lucide icon, muted detail after the label. The step number is a pink chip that jumps to that step.
- Before the first message the log is empty: the head already says what the agent receives, and the composer invites the request.
- History: a popover under its button with the scene's conversations, newest first. Each is a row with its first message (one line, semibold) and, below in `--ink-3`, the agent, the model when it is not the default, how many messages and when (“today, 14:05”, “yesterday, 09:12”, “Nov 3”). The open one is on `--accent-soft`. A click reopens it with all its messages, and the next message continues it. A bin on hover or focus deletes it after a dialog that says its messages and the agent's own copy on this computer go too, while what it changed in the project stays. A conversation that is running cannot be deleted.
- Composer: a lighter card (`--surface-raised`) with a thin line, which takes the focus ring while its text has focus. Its footer has one ghost control for agent, model and reasoning, after T3 Code's: the agent's own mark at 16px (Claude's orange, OpenAI's in ink, Antigravity's app icon; bundled, see `apps/web/src/assets/providers/NOTICE.md`), the model's name and the reasoning as rising bars filled up to the chosen level (“Maximum” is named; automatic draws nothing). It opens a popup in three columns: a 48px rail with the agents' marks at 20px (the one in view on `--accent-soft`, the others faded), the models of the agent in view under a header with its name and version, and a sunken 164px column with the reasoning levels under “Reasoning” and the model's name. An agent that is not installed or not usable yet shows why, with “Detect again”, instead of models. Picking a model keeps the popup open with the focus on the levels; picking a level closes it. Arrow keys move within a column and between columns. A different agent or model starts a new conversation; a level applies from the next message. The round 32px ink button on the right sends, and becomes stop (still ink, never red) while the agent works.
- `Undo run` is a ghost button in the meta line under each finished run, with its time and how many changes it covers. The undo dialog lists what will happen as plain text, then the warnings.
- The button at the right of its head folds it away. With no room to dock, the same button opens the panel as a floating drawer over the board, and closes it.
- Before the first message, adding a harness is asked once, in a notice in the panel.

With the panel folded, a floating pill shows who is changing which step, with `Stop`. As a drawer, Escape or its button folds it again.

**Present.** The drawing fills the screen on `--paper`. A minimal frame floats over it: the “Paso” mark top left and “Exit Esc” top right; the step's title bottom left, the keys bottom right (“← → steps · hold: laser · + − zoom”, and the zoom level with “0 resets” while zoomed). All of this fades out with the pointer, after two seconds. The pager stays: centred at the bottom on a grey pill, with ticks (ink for the current step) and “03 / 06”, between first and previous on its left and next and last on its right. Those four buttons fade with the frame, are disabled at the ends, and a click on them moves only once. “Exit” is reached with the mouse; Esc stays the keyboard's way out, because Tab is kept from wandering to the app underneath.
- One camera per scene, from the union of all its steps and the screen (`present/framing.ts`), so whatever stays still between steps stays still on screen. Margins are 5% and 6% of the screen, never less than 32px and 48px. A scene under 480×300 is framed as if it were that size, so a small sketch is not blown up to the edges.
- A step with its own canvas colour fills the screen with it, through the same dark filter as its drawing.
- Above 24 steps, or under 480px wide, the pager drops the ticks and keeps the numbers.
- Manual navigation uses the board gestures. A trackpad pinch or Ctrl/Cmd + wheel zooms around the pointer with Excalidraw's response and 0.1–30× limits relative to the opening frame. Two-finger scrolling or the wheel pans, Shift + wheel pans horizontally, and Space + drag or the middle mouse button pans freely. Space no longer advances a step, and releasing a drag never changes the step. + and − change zoom by 0.1; 0 restores the step's saved camera, or the scene frame. Direct gestures have no transition delay. Manual navigation stays between steps without a saved camera. The laser is the Canvas's: Excalidraw's laser cursor over the drawing, and while the pointer is held its red trail (`@excalidraw/laser-pointer`, with the options of Excalidraw 0.18.1), which fades within a second of the release; a press or click never changes the step, which only the pager and the keys do. Ctrl/Cmd with + and − stays the browser's zoom.

**Dialogs and menus.** Dialogs are the chrome's grey, 16px radius, with a large shadow over a dim scrim. They have a 20px semibold title and the actions on the right on a sunken band under a thin rule, as in T3 Code; the destructive action is red text on a pale red fill. Menus and popovers are cards on the chrome's grey with 8px corners, a thin line and a large shadow. Items are 28px with 4px radius and a grey hover, and a checked item has a grey fill. See “Controls”.

## Excalidraw: measured on 0.18.1, not assumed

Measured by running the real component in a 1184×724 container, positioned as on the Canvas.

| Control | x, y from container | Size |
| --- | --- | --- |
| Main menu | 16, 16 | 36×36 |
| Shape toolbar | centred, y 16 | 550×44 (564 with lock) |
| Hint text | centred, y 68 | 550×24 |
| Properties panel | 16, 76 | 200 wide, scrolls |
| Library | right 16, y 16 | 100×36 |
| Zoom | 16, bottom 16 | 132×36 |
| Undo and redo | 158, bottom 16 | 72×36 |
| Help | right 16, bottom 16 | 36×36 |

- **Width.** Keep the container at 744px or wider (`--canvas-min-w`): below 730px Excalidraw switches to its mobile layout and moves the toolbar. The agent folds when docking it would take the board under 760px, and the sidebar opens over the board under a 1064px window. The library button is hidden; Present takes its corner.
- **Height.** The properties panel shrinks and scrolls with its container, ending 38px above the zoom controls. Re-measured with the two-row header and the carousel in a 1280×720 window (IN-05).
- **Offline.** By default Excalifont loads from `esm.sh`. Set `window.EXCALIDRAW_ASSET_PATH` and serve a copy of the package's `dist/prod/fonts`. Verified: no external requests with this set.
- **Vite.** Add `define: { 'process.env.IS_PREACT': JSON.stringify('false') }`, or the component does not render.
- **Inherited type.** Excalidraw inherits `font-size` and `line-height`, and its panel spacing drifts if an ancestor sets them. Reset both on its wrapper: `font-size: 16px; line-height: normal`.
- **Text before fonts.** Text measured before Excalifont has loaded gets clipped on the canvas. Load the font before creating or converting text elements, which matters for agent-written scenes.
- **Theme.** `tokens.css` maps Excalidraw's primary colours to Paso's ink, its islands and corner buttons to white cards with a thin line (the `--work-*` tokens, swapped in on `.excalidraw`), and its UI font to Inter. One variable drives both the active tool and all selected options in the properties panel: the grey fill (`--accent-soft`) with ink, so a panel full of selected options stays calm.
- **Selection colour.** `--color-selection` goes straight to the canvas, which rejects `light-dark()` and silently draws black, so each theme sets a literal: `#7a7060` (the focus grey) in light, and `#5f574b` in dark. The dark canvas runs through Excalidraw's filter, which turns `#5f574b` into about `#a7a096`.
- **Main menu.** The default includes Excalidraw's GitHub, X and Discord links. Replace it with a custom `<MainMenu>` holding only what Paso needs: “Export image”, then a “Preferences” group, then “Canvas background”.
- **Preferences.** 0.18.1 has no preferences submenu, so Paso builds the group itself: “Show grid”, “Zen mode” and “View mode” as check items (`menuitemcheckbox`) with Excalidraw's own shortcuts, then “Theme” with Light, Dark and System. The grid is saved with each step, as Excalidraw saves it with a drawing. Zen and view mode are how the person is looking, so they carry over to the next step and are not saved. “View mode” is Excalidraw's own English name, and does not read as Present.
- **Theme.** The theme row reuses Excalidraw's radio row markup with Paso's own labels, because its built-in row has no System choice. The choice sets `data-theme` on `<html>` for the whole window and is remembered in this browser; “System” removes it and the OS decides. Excalidraw's Alt+Shift+D also switches the whole window.
- **Language.** Excalidraw runs with `langCode="en"`, so its own menus, dialogs and help match Paso's English. The Canvas hides `.HintViewer`, the hint under the toolbar, to keep the canvas to the drawing and Paso's own controls.
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
- Overlays on the canvas beyond Excalidraw's own, Present, which takes the library button's corner, and the sidebar's button, which takes the top left one. New controls go in the sidebar, the step strip, the chat, or Excalidraw's main menu.
- Text below 12px, except the uppercase eyebrow.
- Absolutely placed elements, such as visually hidden live regions, inside a scroll container that is not positioned. Their containing block becomes the window, and they make the whole document scroll. `.board` is `position: relative` for this reason.
