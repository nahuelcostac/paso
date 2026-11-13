# Paso data format, version 1

A project is a folder. Each step is a complete Excalidraw document snapshot.
Steps have no inheritance, deltas or visibility layers. An element array sets
the drawing order. Deleted elements can stay in that array with `isDeleted` set
to `true`.

```text
<project>/
  project.json
  assets/<fileId>.<ext>
  scenes/<sceneId>/
    scene.json
    steps/<stepId>.json
```

This follows the proposed layout. Every JSON document carries `schemaVersion`
with the integer value `1`. Use UTF-8, two-space indentation and a final newline.
Use stable IDs for paths. Names and titles are display text. Renames do not move
files. IDs used in paths contain 1 to 128 ASCII letters, digits, underscores or
hyphens. Creation helpers generate UUIDs unless an ID is supplied.

## Loose diagrams

A loose diagram is one scene, with its steps, that belongs to no project. Loose
diagrams are kept in a reserved project, so the model stays project > scenes >
steps. Each workspace has its own, in a hidden folder at its root:

```text
<workspace>/
  <project>/...
  .loose/
    project.json        id "_loose", name "Diagramas sueltos"
    assets/<fileId>.<ext>
    scenes/<sceneId>/...
```

The folder name starts with a dot, so Finder and `ls` hide it, and it is not a
valid project ID, so a scan for projects never finds it by accident. Its documents
are ordinary version 1 documents: `project.json` has the ID `_loose`, and the
filesystem adapter maps that ID to the folder `.loose`. A plain `_loose` folder,
if one exists, is ignored. Each scene is one loose diagram, in creation order in
`sceneIds`. The app never shows the reserved project as a project: not in the
list, the search or «Abrir carpeta». `@paso/shared` exports `LOOSE_PROJECT_ID`,
`LOOSE_PROJECT_FOLDER`, `LOOSE_PROJECT_NAME` and `isLooseProject`.

A scene can move into another project, last or at a chosen place among its scenes: a loose diagram into a project, a
project's scene out into `.loose`, where it becomes a loose diagram, or from one
project to another. It keeps the same scene, step and element IDs. While a move
is under way, the service may leave `<source>/.moves/<sceneId>.json` and
`<target>/.incoming/<sceneId>/`; neither is part of a project, and both are gone
once the move finishes or is undone (see the service API).

## Documents

| File | Required fields | Optional fields |
| --- | --- | --- |
| `project.json` | `schemaVersion`, `id`, `name`, `createdAt`, `updatedAt`, `sceneIds` | `icon` |
| `scene.json` | `schemaVersion`, `id`, `name`, `stepIds` | None |
| Step JSON | `schemaVersion`, `id`, `elements`, `appState`, `files` | `title`, `speakerNotes`, `camera` |

`icon` is the name of a [Lucide](https://lucide.dev) icon in kebab case, such as
`folder` or `chart-scatter`. It is for the project list and needs no format change:
files without it stay valid at version 1, and the app shows `folder` for them. The
schema checks only the shape (lowercase letters, digits and single hyphens, at most
64 characters), not the list of icons, so a newer Lucide release needs no change here.
An app that does not know a name shows `folder`. Scenes and steps have no icon.

`camera` is the part of the drawing Presentar zooms to on that step:
`{ "x", "y", "width", "height" }` in canvas units, with x/y at the top-left and a
positive width and height. A step without it shows the whole scene, framed from the
union of all its steps. Only the presentation reads it: the editor, thumbnails and
exports ignore it. It was added without a version change, since files without it
stay valid, and `duplicateStep` copies it like any other field.

Project timestamps are ISO 8601 strings with a time zone, for example
`2026-11-07T12:00:00.000Z`. The writer must update `updatedAt` when project
content changes. No filesystem writer is part of the shared package.

`sceneIds` and `stepIds` contain each immediate child exactly once, in display
order. Reordering changes only the parent list. Empty projects and scenes are
valid. Document IDs are unique across a project. Element IDs are unique within
each step and can repeat across steps and scenes.

To add a step, copy a complete step, give the copy a new step ID, and add its ID
to the scene's `stepIds`. Keep element IDs to preserve identity for future
transitions. Edit only the copy. `duplicateStep` performs a deep copy, including
unknown nested element fields and asset metadata. Assets remain shared files.

## Elements and appState

The element schema checks only `id`, `type`, integer `version`, integer
`versionNonce`, boolean `isDeleted`, and an optional nullable `fileId`.
It preserves all unknown fields and accepts unknown element types. Excalidraw
owns geometry, bindings, indexes and custom data. Dropping fields that Paso
does not know would corrupt drawings after an Excalidraw upgrade. The shared
package has no Excalidraw dependency and does not restore or render elements.
Callers must supply JSON-serializable Excalidraw documents.

`appState` uses an allow-list. Parsing removes every other field.

| Persisted field | Type |
| --- | --- |
| `viewBackgroundColor` | Nonempty string |
| `gridSize` | Integer from 1 to 100 |
| `gridStep` | Integer from 1 to 100 |
| `gridModeEnabled` | Boolean |

All four fields are optional. An omitted field uses Excalidraw's restore default.
Selection, cursor, collaborators, zoom, scroll, editing tools, theme and export
preferences are excluded. The app must persist the parsed allow-list, rather
than the live Excalidraw state. Top-level Paso documents reject unknown keys
to catch hand-editing mistakes.

These choices were checked against the published npm tarball for
`@excalidraw/excalidraw@0.18.1`, unpacked outside the repository. The source
`dist/dev/chunk-4FTI6OG3.js`, `APP_STATE_STORAGE_CONF` at lines 540 to 644,
marks exactly these four keys with `export: true` and `server: true`.
`dist/types/excalidraw/types.d.ts` declares their types. The same development
bundle's `getNormalizedGridSize` and `getNormalizedGridStep` clamp grid values
to integers from 1 to 100. Its defaults are grid size 20 and step 5. No
Excalidraw package was added to this repository.

## Images

`files` maps each Excalidraw `fileId` to project-level asset metadata.

```json
{
  "dc9037ecae804ca6b7615c9810b3fa12": {
    "path": "assets/dc9037ecae804ca6b7615c9810b3fa12.svg",
    "mimeType": "image/svg+xml",
    "created": 1794052800000
  }
}
```

Paths are relative to the project root and must match `assets/<fileId>.<ext>`.
The extension is lowercase ASCII letters or digits. No arbitrary paths or
embedded binary data are allowed. `created` is an epoch timestamp in
milliseconds. An optional integer `version` preserves Excalidraw's binary
version metadata. `lastRetrieved` is a cache timestamp and is not persisted.

Every non-null element `fileId`, including one on a deleted element, needs a
manifest entry in that step. A pending image may have `fileId: null`.
Extra manifest entries are allowed. Entries for the same file ID must agree
across the project. Treat asset IDs as immutable binary identities. Replacing
an image with different bytes requires a new file ID. Duplicating a step copies
the manifest and keeps its paths, without copying binaries. Later adapters
can load each asset into Excalidraw's `BinaryFileData` using the manifest key
as `id` and the loaded bytes as `dataURL`.

## Shared API and validation

`@paso/shared` exports the Zod schemas and inferred types `Project`, `Scene`,
`Step`, `ExcalidrawElement`, `PersistedAppState`, `FileManifestEntry`,
`FilesManifest` and `ProjectTree`.

Use `parseProject`, `parseScene` and `parseStep` for decoded JSON values.
They call `migrateDocument`, the single migration entry point. Version 1
needs no conversion. Missing, older and invalid versions fail. Newer versions
fail with an explicit upgrade message before their content is parsed.
Direct schema parsing has the same version guard. No migration framework is
needed yet.

`createProject`, `createScene` and `createStep` return detached documents with
empty children or content by default. `createProject` also takes an optional
`icon`. Supply IDs and a project `now` string for deterministic creation. They do not insert documents into parents or change
existing documents. `duplicateStep` accepts a source and an optional new ID.

`validateProjectTree` takes the following in-memory shape and returns a parsed
copy, or throws a Zod error with issue paths. Arrays let the validator detect
duplicate children that a map could hide.

```ts
{
  project: Project,
  scenes: Array<{ scene: Scene; steps: Step[] }>
}
```

Tree validation checks document IDs, both order lists, per-step element IDs,
file references and shared asset metadata. Child arrays need not be in
presentation order. Filesystem adapters must also check that file and folder
names match document IDs, assets exist, and no unlisted files were missed.
The pure shared validator cannot inspect paths or bytes on disk.

The sample content in `examples/demo-project/` has two scenes, four steps and
one shared image. Tests discover its child files from disk before validation,
so an extra or missing step file cannot be hidden by the order arrays.
