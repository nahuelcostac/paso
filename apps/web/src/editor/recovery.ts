import type { Draft, Recovery } from './step-store';

/** IndexedDB can hold image bytes too. Nothing enters the project format until the API saves it. */
export class BrowserRecovery implements Recovery {
  private database?: Promise<IDBDatabase>;
  constructor(private namespace: string) {}
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('paso-step-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async request<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', mode);
      const request = action(transaction.objectStore('drafts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  read(key: string) { return this.request<Draft | undefined>('readonly', (store) => store.get(`${this.namespace}/${key}`)); }
  async write(key: string, draft: Draft) { await this.request('readwrite', (store) => store.put(draft, `${this.namespace}/${key}`)); }
  async remove(key: string) { await this.request('readwrite', (store) => store.delete(`${this.namespace}/${key}`)); }
}
