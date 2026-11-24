import { idSchema } from '@paso/shared';
import { ApiError } from '../errors.js';

/** How many steps one message may name. A whole scene fits; the harness gets their IDs only. */
export const maxSteps = 50;

const invalid = () => new ApiError(400, 'INVALID_ATTACHMENT', "That step can't be attached.");

/** Whether an attachment names a step (`{ kind: "step", stepId }`) rather than carrying an image. */
export const isStepItem = (item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item) && (item as Record<string, unknown>).kind === 'step';

/**
 * The steps a message names, in order and each once. Only their IDs are read: where they are, their number and their
 * title come from the project itself (`resolveSteps`), never from the client.
 */
export function parseStepAttachments(items: unknown[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (!isStepItem(item)) throw invalid();
    const parsed = idSchema.safeParse((item as Record<string, unknown>).stepId);
    if (!parsed.success) throw invalid();
    if (!ids.includes(parsed.data)) ids.push(parsed.data);
  }
  if (ids.length > maxSteps) throw new ApiError(400, 'TOO_MANY_STEPS', `A message can name up to ${maxSteps} steps.`);
  return ids;
}

/** Said when a named step is not in the project any more, or never was. Nothing is sent. */
export const stepNotFound = () => new ApiError(422, 'STEP_NOT_FOUND', 'A step attached to this message is no longer in the project. Remove it and send again.');
