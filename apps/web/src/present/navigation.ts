export type PresentAction = 'next' | 'previous' | 'first' | 'last' | 'exit';

const KEYS: Record<string, PresentAction> = {
  ArrowRight: 'next', ' ': 'next', PageDown: 'next',
  ArrowLeft: 'previous', PageUp: 'previous',
  Home: 'first', End: 'last',
  Escape: 'exit',
};

/** The action of a key press. A key with a modifier belongs to the browser or the system, such as Alt and left for going back. */
export function keyAction(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): PresentAction | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  return KEYS[event.key];
}

/** A click goes forward on the right half of the screen and back on the left half. */
export const clickAction = (x: number, width: number): PresentAction => (x < width / 2 ? 'previous' : 'next');

/** The step after an action. It stops at both ends: no wrapping round, and the last step does not end the presentation. */
export function moveIndex(action: Exclude<PresentAction, 'exit'>, index: number, count: number) {
  const last = Math.max(0, count - 1);
  if (action === 'first') return 0;
  if (action === 'last') return last;
  return Math.min(last, Math.max(0, index + (action === 'next' ? 1 : -1)));
}

/** The steps to have ready, most urgent first: the one on screen, then outwards, forward before back. */
export function preparationOrder(index: number, count: number, reach = 2) {
  const order = [index];
  for (let distance = 1; distance <= reach; distance++) order.push(index + distance, index - distance);
  return order.filter((position) => position >= 0 && position < count);
}
