import { describe, expect, it } from 'vitest';
import { clickAction, keyAction, moveIndex, preparationOrder } from './navigation';

const press = (key: string, modifiers: Partial<KeyboardEvent> = {}) => keyAction({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });

describe('keys of a presentation', () => {
  it.each([['ArrowRight', 'next'], [' ', 'next'], ['PageDown', 'next'], ['ArrowLeft', 'previous'], ['PageUp', 'previous'], ['Home', 'first'], ['End', 'last'], ['Escape', 'exit']])('%j means %s', (key, action) => {
    expect(press(key)).toBe(action);
  });
  it('leaves other keys and modified keys to the browser', () => {
    for (const key of ['a', 'Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'F5']) expect(press(key)).toBeUndefined();
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) expect(press('ArrowLeft', { [modifier]: true })).toBeUndefined();
  });
});

describe('moving between steps', () => {
  it('goes one step at a time and stops at both ends', () => {
    expect(moveIndex('next', 0, 3)).toBe(1); expect(moveIndex('previous', 2, 3)).toBe(1);
    expect(moveIndex('next', 2, 3)).toBe(2); expect(moveIndex('previous', 0, 3)).toBe(0);
  });
  it('jumps to the first and last', () => { expect(moveIndex('first', 2, 3)).toBe(0); expect(moveIndex('last', 0, 3)).toBe(2); });
  it('has nowhere to go in a scene of one step', () => { for (const action of ['next', 'previous', 'first', 'last'] as const) expect(moveIndex(action, 0, 1)).toBe(0); });
  it('splits a click at the middle of the screen', () => {
    expect(clickAction(100, 1000)).toBe('previous'); expect(clickAction(499, 1000)).toBe('previous');
    expect(clickAction(500, 1000)).toBe('next'); expect(clickAction(900, 1000)).toBe('next');
  });
});

describe('what to prepare', () => {
  it('starts with the step on screen and goes outwards, forward first', () => { expect(preparationOrder(5, 10)).toEqual([5, 6, 4, 7, 3]); });
  it('stays inside the scene', () => { expect(preparationOrder(0, 2)).toEqual([0, 1]); expect(preparationOrder(0, 1)).toEqual([0]); expect(preparationOrder(9, 10)).toEqual([9, 8, 7]); });
  it('never asks for more than a few pages, however long the scene', () => { expect(preparationOrder(500, 1000).length).toBe(5); });
});
