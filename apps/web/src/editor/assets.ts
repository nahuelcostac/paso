import type { Step } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import type { Binaries } from './step-store';

export function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export async function loadFiles(api: ApiClient, projectId: string, step: Step, local: Binaries = {}): Promise<Binaries> {
  const files: Binaries = { ...local };
  await Promise.all(Object.entries(step.files).map(async ([id, entry]) => {
    if (files[id]) return;
    const response = await api.asset(projectId, entry.path);
    const blob = new Blob([await response.arrayBuffer()], { type: entry.mimeType });
    files[id] = { id, dataURL: await blobDataURL(blob), mimeType: entry.mimeType, created: entry.created, ...(entry.version === undefined ? {} : { version: entry.version }) };
  }));
  return files;
}
