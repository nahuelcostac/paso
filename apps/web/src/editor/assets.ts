import type { FileManifestEntry, Step } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import type { Binaries, Binary } from './step-store';

export function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Images already read, per service. An image's file is named by its ID, which Excalidraw makes from its bytes, and
 * never changes: steps that share an image (a duplicated step keeps them) read it once, so moving between them waits
 * for nothing. A read that failed is forgotten and tried again. The oldest go first past the limit.
 */
const CACHED_FILES = 200;
const cache = new WeakMap<ApiClient, Map<string, Promise<Binary>>>();
function read(api: ApiClient, projectId: string, id: string, entry: FileManifestEntry): Promise<Binary> {
  const files = cache.get(api) ?? new Map<string, Promise<Binary>>();
  cache.set(api, files);
  const key = JSON.stringify([projectId, id, entry.path, entry.mimeType, entry.created, entry.version]);
  const known = files.get(key);
  if (known) return known;
  const loading = (async () => {
    const response = await api.asset(projectId, entry.path);
    const blob = new Blob([await response.arrayBuffer()], { type: entry.mimeType });
    return { id, dataURL: await blobDataURL(blob), mimeType: entry.mimeType, created: entry.created, ...(entry.version === undefined ? {} : { version: entry.version }) };
  })();
  files.set(key, loading);
  loading.catch(() => { if (files.get(key) === loading) files.delete(key); });
  while (files.size > CACHED_FILES) files.delete(files.keys().next().value!);
  return loading;
}

export async function loadFiles(api: ApiClient, projectId: string, step: Step, local: Binaries = {}): Promise<Binaries> {
  const files: Binaries = { ...local };
  await Promise.all(Object.entries(step.files).map(async ([id, entry]) => {
    if (files[id]) return;
    files[id] = { ...await read(api, projectId, id, entry) };
  }));
  return files;
}
