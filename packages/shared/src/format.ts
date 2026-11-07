import { z } from 'zod';

export const SCHEMA_VERSION = 1;

const schemaVersionSchema = z.literal(SCHEMA_VERSION, {
  error: (issue) => typeof issue.input === 'number' && issue.input > SCHEMA_VERSION
    ? `Schema version ${issue.input} is newer than supported version ${SCHEMA_VERSION}. Upgrade Paso before opening this file.`
    : `Unsupported schemaVersion. Expected ${SCHEMA_VERSION}.`,
});

// IDs become path components. Names never do.
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestampSchema = z.iso.datetime({ offset: true });

// A Lucide icon name in kebab case, such as "folder" or "chart-scatter". Only the shape is
// checked: the list of icons belongs to the app, so new Lucide releases need no format change.
export const iconNameSchema = z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'An icon name uses lowercase letters, digits and single hyphens.');

export const projectSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  name: z.string().min(1),
  icon: iconNameSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  sceneIds: z.array(idSchema),
}).strict();

export const sceneSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  name: z.string().min(1),
  stepIds: z.array(idSchema),
}).strict();

// Keep all fields owned by Excalidraw, including fields from future releases.
export const excalidrawElementSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().int(),
  isDeleted: z.boolean(),
  fileId: idSchema.nullable().optional(),
}).passthrough();

// Excalidraw 0.18.1 APP_STATE_STORAGE_CONF marks exactly these fields for export.
// Unknown keys are stripped so UI state cannot enter the persisted document.
export const persistedAppStateSchema = z.object({
  viewBackgroundColor: z.string().min(1).optional(),
  gridSize: z.number().int().min(1).max(100).optional(),
  gridStep: z.number().int().min(1).max(100).optional(),
  gridModeEnabled: z.boolean().optional(),
});

export const fileManifestEntrySchema = z.object({
  path: z.string().regex(/^assets\/[A-Za-z0-9_-]{1,128}\.[a-z0-9]+$/),
  mimeType: z.string().min(1),
  created: z.number().int().nonnegative(),
  version: z.number().int().nonnegative().optional(),
}).strict();

export const filesManifestSchema = z.record(idSchema, fileManifestEntrySchema)
  .superRefine((files, context) => {
    for (const [fileId, file] of Object.entries(files)) {
      if (!file.path.startsWith(`assets/${fileId}.`)) {
        context.addIssue({ code: 'custom', path: [fileId, 'path'], message: 'Asset path must use its fileId as the filename.' });
      }
    }
  });

export const stepSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  title: z.string().optional(),
  speakerNotes: z.string().optional(),
  elements: z.array(excalidrawElementSchema),
  appState: persistedAppStateSchema,
  files: filesManifestSchema,
}).strict();

export type Project = z.infer<typeof projectSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Step = z.infer<typeof stepSchema>;
export type ExcalidrawElement = z.infer<typeof excalidrawElementSchema>;
export type PersistedAppState = z.infer<typeof persistedAppStateSchema>;
export type FileManifestEntry = z.infer<typeof fileManifestEntrySchema>;
export type FilesManifest = z.infer<typeof filesManifestSchema>;

/** Version 1 needs no conversion. Reject all unsupported versions before parsing. */
export function migrateDocument(input: unknown): unknown {
  const envelope = z.object({ schemaVersion: schemaVersionSchema }).passthrough();
  envelope.parse(input);
  return input;
}

export function parseProject(input: unknown): Project {
  return projectSchema.parse(migrateDocument(input));
}

export function parseScene(input: unknown): Scene {
  return sceneSchema.parse(migrateDocument(input));
}

export function parseStep(input: unknown): Step {
  return stepSchema.parse(migrateDocument(input));
}
