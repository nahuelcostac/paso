import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, isMissing } from '../errors.js';

/**
 * What a person attaches to a message, each with its own `kind`: an image, kept with the conversation, or a step of the
 * project (`steps.ts`), which is only named, never copied.
 */
export type ImageAttachmentRef = { id: string; kind: 'image'; mediaType: ImageMediaType; size: number; name?: string };
/**
 * A step the message is about, as it was when the message was sent: its IDs, its place (`number`, from 1) and its
 * scene's name and its title, so the history can name it even after it changes or goes. `id` is the step's ID.
 */
export type StepAttachmentRef = { id: string; kind: 'step'; sceneId: string; stepId: string; number: number; sceneName: string; title?: string };
export type AttachmentRef = ImageAttachmentRef | StepAttachmentRef;
/** An image on its way to the harness: its bytes as base64, in memory only. It never names a file. */
export type ImageInput = { mediaType: ImageMediaType; data: string };

export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = typeof imageMediaTypes[number];
export const maxImageBytes = 5 * 1024 * 1024;
export const maxAttachments = 5;
/** Enough for five images of the largest size in base64, the longest text and the JSON around them. */
export const maxMessageBodyBytes = maxAttachments * Math.ceil((maxImageBytes * 4) / 3) + 1024 * 1024;

const extensions: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Strict base64: a backtracking pattern over megabytes would overflow the stack, so the shape is checked in parts. */
const isBase64 = (value: string) => value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) && /^[^=]*={0,2}$/.test(value);
const startsWith = (bytes: Buffer, signature: number[], at = 0) => bytes.length >= at + signature.length && signature.every((byte, index) => bytes[at + index] === byte);

/** The type the bytes really are, from their signature. The declared type is never trusted alone. */
export function sniffImage(bytes: Buffer): ImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

const invalid = () => new ApiError(400, 'INVALID_ATTACHMENT', 'Attach PNG, JPEG, GIF or WebP images only.');
const tooLarge = () => new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Each image must be 5 MB or smaller.');

/** A name to show, never a path: its last segment, without control characters, at most 120 characters. */
function cleanName(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const name = Array.from(value.split(/[\\/]/).pop()!).filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 120);
  return name || undefined;
}

export type ParsedImage = { mediaType: ImageMediaType; bytes: Buffer; name?: string };

/** Checks a message's attachments: at most five images, each of an allowed type that its bytes confirm, up to 5 MB. */
export function parseAttachments(input: unknown): ParsedImage[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw invalid();
  if (input.length > maxAttachments) throw new ApiError(400, 'TOO_MANY_ATTACHMENTS', 'A message can have up to 5 images.');
  return input.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid();
    const { kind, mediaType, data, name } = item as Record<string, unknown>;
    if (kind !== 'image' || typeof mediaType !== 'string' || !(imageMediaTypes as readonly string[]).includes(mediaType) || typeof data !== 'string') throw invalid();
    // Checked before decoding, so an oversized image costs no memory.
    if (data.length > Math.ceil((maxImageBytes * 4) / 3) + 4) throw tooLarge();
    if (!data.length || !isBase64(data)) throw invalid();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > maxImageBytes) throw tooLarge();
    if (sniffImage(bytes) !== mediaType) throw invalid();
    return { mediaType: mediaType as ImageMediaType, bytes, ...(cleanName(name) ? { name: cleanName(name) } : {}) };
  });
}

/**
 * The images of each conversation, in the service's own data folder (`agent-attachments/<session>/<id>.<ext>`, mode
 * 0600 in 0700 folders), never in a project folder. They are read back only to show them in the history and to hand
 * them to the harness as content; no path is ever given to an agent.
 */
export class AttachmentStore {
  constructor(private readonly dir: string) {}

  private folder(sessionId: string) {
    if (!idPattern.test(sessionId)) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', "That image doesn't exist.");
    return join(this.dir, sessionId);
  }

  async save(sessionId: string, images: ParsedImage[]): Promise<ImageAttachmentRef[]> {
    if (!images.length) return [];
    const folder = this.folder(sessionId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const saved: ImageAttachmentRef[] = [];
    try {
      for (const image of images) {
        const id = randomUUID();
        await writePrivate(join(folder, `${id}.${extensions[image.mediaType]}`), image.bytes);
        saved.push({ id, kind: 'image', mediaType: image.mediaType, size: image.bytes.length, ...(image.name ? { name: image.name } : {}) });
      }
    } catch (error) {
      await this.remove(sessionId, saved.map((ref) => ref.id));
      throw error;
    }
    return saved;
  }

  async read(sessionId: string, id: string): Promise<{ mediaType: ImageMediaType; bytes: Buffer }> {
    const folder = this.folder(sessionId);
    const missing = () => new ApiError(404, 'ATTACHMENT_NOT_FOUND', "That image doesn't exist.");
    if (!idPattern.test(id)) throw missing();
    for (const mediaType of imageMediaTypes) {
      let bytes: Buffer;
      try { bytes = await readFile(join(folder, `${id}.${extensions[mediaType]}`)); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      // Stored files were checked on the way in; a file that changed since is not served as an image.
      if (sniffImage(bytes) !== mediaType) throw missing();
      return { mediaType, bytes };
    }
    throw missing();
  }

  async remove(sessionId: string, ids: string[]) {
    const folder = this.folder(sessionId);
    for (const id of ids) {
      if (!idPattern.test(id)) continue;
      for (const mediaType of imageMediaTypes) await rm(join(folder, `${id}.${extensions[mediaType]}`), { force: true });
    }
  }

  /** Deletes every image of a conversation. */
  async drop(sessionId: string) {
    if (!idPattern.test(sessionId)) return;
    await rm(join(this.dir, sessionId), { recursive: true, force: true });
  }

  /** Deletes the images of conversations the service no longer knows, such as ones forgotten at a restart. */
  async prune(keep: (sessionId: string) => boolean) {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    for (const name of names) if (idPattern.test(name) && !keep(name)) await rm(join(this.dir, name), { recursive: true, force: true });
  }
}

async function writePrivate(file: string, data: Buffer) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
