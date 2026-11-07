// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { bindStepLifecycle } from './lifecycle';
import type { StepStore } from './step-store';
it('flushes on hide and pagehide, guards unsaved close, and removes listeners', () => {
  const store = { flushAll: vi.fn(async () => {}), hasUnsaved: () => true, stopTimers: vi.fn() };
  const unbind = bindStepLifecycle(store as unknown as StepStore);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange')); expect(store.flushAll).toHaveBeenLastCalledWith(true);
  window.dispatchEvent(new Event('pagehide')); expect(store.flushAll).toHaveBeenCalledTimes(2);
  const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave); expect(leave.defaultPrevented).toBe(true);
  unbind(); expect(store.stopTimers).toHaveBeenCalledOnce();
  const calls = store.flushAll.mock.calls.length; window.dispatchEvent(new Event('pagehide')); expect(store.flushAll).toHaveBeenCalledTimes(calls);
});
