import { z } from 'zod';
import { idSchema } from '@paso/shared';

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const size = z.number().finite().min(1).max(20_000);
const text = z.string().min(1).max(4000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #1b1b1f.');
const style = {
  strokeColor: color.optional(),
  backgroundColor: z.union([color, z.literal('transparent')]).optional(),
  strokeWidth: z.number().min(1).max(8).optional(),
  opacity: z.number().int().min(0).max(100).optional(),
};
const fontSize = z.number().min(12).max(96);
const shape = {
  id: idSchema, x: coordinate, y: coordinate,
  width: size.optional(), height: size.optional(),
  label: text.optional(), fontSize: fontSize.optional(), ...style,
};
export const elementInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rectangle'), ...shape }).strict(),
  z.object({ type: z.literal('ellipse'), ...shape }).strict(),
  z.object({ type: z.literal('diamond'), ...shape }).strict(),
  z.object({ type: z.literal('text'), id: idSchema, x: coordinate, y: coordinate, text, fontSize: fontSize.optional(), ...style }).strict(),
  z.object({ type: z.literal('arrow'), id: idSchema, fromId: idSchema, toId: idSchema, strokeColor: color.optional(), strokeWidth: style.strokeWidth, opacity: style.opacity }).strict(),
]);
export const elementPatch = z.object({
  id: z.string().min(1).max(256), x: coordinate.optional(), y: coordinate.optional(),
  width: size.optional(), height: size.optional(), label: text.nullable().optional(),
  text: text.optional(), fontSize: fontSize.optional(), fromId: idSchema.optional(), toId: idSchema.optional(), ...style,
}).strict().refine((patch) => Object.keys(patch).length > 1, 'Supply at least one property to change.');
export const targetShape = { projectId: idSchema, sceneId: idSchema, stepId: idSchema };
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Use the unquoted revision from read_step. Read again after REVISION_CONFLICT.');
export type ElementInput = z.infer<typeof elementInput>;
export type ElementPatch = z.infer<typeof elementPatch>;
export type Target = { projectId: string; sceneId: string; stepId: string };
