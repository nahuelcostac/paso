import type { StepStore } from './step-store';

/** Browsers cannot wait for arbitrary network writes on close. Keepalive starts the flush,
 * IndexedDB keeps the draft, and beforeunload protects work that has not reached the service. */
export function bindStepLifecycle(store: StepStore, page: Document = document, host: Window = window) {
  const hide = () => { if (page.visibilityState === 'hidden') void store.flushAll(true); };
  const pagehide = () => { void store.flushAll(true); };
  const leave = (event: BeforeUnloadEvent) => {
    void store.flushAll(true);
    if (store.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; }
  };
  page.addEventListener('visibilitychange', hide);
  host.addEventListener('pagehide', pagehide);
  host.addEventListener('beforeunload', leave);
  return () => {
    page.removeEventListener('visibilitychange', hide); host.removeEventListener('pagehide', pagehide); host.removeEventListener('beforeunload', leave);
    void store.flushAll(); store.stopTimers();
  };
}
