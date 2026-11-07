// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepCarousel } from './StepCarousel';

afterEach(cleanup);
const ids = ['a', 'b', 'c', 'd'];
const handlers = () => ({
  onSelect: vi.fn<(stepId: string) => void>(), onAdd: vi.fn<() => void>(), onDuplicate: vi.fn<() => void>(),
  onNudge: vi.fn<(stepId: string, delta: -1 | 1) => Promise<{ index: number; count: number }>>(async (_id, delta) => ({ index: 1 + delta, count: 4 })),
  onMove: vi.fn<(stepId: string, index: number) => Promise<void>>(async () => {}),
  onDelete: vi.fn<(stepId: string) => Promise<void>>(async () => {}),
});
function setup(extra: Partial<ReturnType<typeof handlers> & { stepIds: string[]; currentId: string | undefined }> = {}) {
  const props = { stepIds: ids, currentId: 'b' as string | undefined, svgs: {}, titles: { c: 'Tercero' }, busy: false, ...handlers(), ...extra };
  const tree = (next: typeof props) => <><div tabIndex={0} data-testid="canvas" /><StepCarousel {...next} /></>;
  const view = render(tree(props));
  /** Draws the carousel again with other props, in the same place in the tree so nothing remounts. */
  const redraw = (changes: Partial<typeof props>) => view.rerender(tree({ ...props, ...changes }));
  return { props, redraw, ...view };
}
const frame = (n: number) => screen.getByRole('button', { name: new RegExp(`^Paso ${n}`) });

describe('step carousel', () => {
  it('marks the current step, numbers every frame and keeps one tab stop', () => {
    setup();
    expect(frame(2)).toHaveAttribute('aria-current', 'step');
    expect(frame(1)).not.toHaveAttribute('aria-current');
    expect(screen.getAllByText(/^0[1-4]$/).map((n) => n.textContent)).toEqual(['01', '02', '03', '04']);
    expect([1, 2, 3, 4].map((n) => frame(n).getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    // No room for a title in the strip: it goes in the tooltip.
    expect(frame(3)).toHaveAttribute('title', 'Tercero'); expect(screen.queryByText('Tercero')).not.toBeInTheDocument();
  });
  it('arrow keys move between steps only while focus is inside the carousel', async () => {
    const { props } = setup(); const user = userEvent.setup();
    frame(2).focus();
    await user.keyboard('{ArrowRight}'); expect(props.onSelect).toHaveBeenLastCalledWith('c'); expect(frame(3)).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}'); expect(props.onSelect).toHaveBeenLastCalledWith('a');
    await user.keyboard('{ArrowLeft}'); expect(props.onSelect).toHaveBeenCalledTimes(3);   // the first step has no previous one
    await user.keyboard('{End}'); expect(props.onSelect).toHaveBeenLastCalledWith('d');
    await user.keyboard('{Home}'); expect(props.onSelect).toHaveBeenLastCalledWith('a');
    props.onSelect.mockClear();
    // The canvas (or anywhere else) is not ours: these keys belong to Excalidraw, and nothing is bound on the window.
    screen.getByTestId('canvas').focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{Home}{End}{Delete}{Backspace}2{Alt>}{ArrowLeft}{/Alt}');
    expect(props.onSelect).not.toHaveBeenCalled(); expect(props.onNudge).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
  it('reorders with Alt and the arrows, and focus returns to the moved step', async () => {
    const { props, redraw } = setup(); const user = userEvent.setup();
    frame(2).focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(props.onNudge).toHaveBeenCalledWith('b', -1);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Paso movido a la posición 1 de 4.'));
    // The parent draws the new order: b moves to the front, and the focus follows it.
    redraw({ stepIds: ['b', 'a', 'c', 'd'] });
    await waitFor(() => expect(frame(1)).toHaveFocus());
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}'); expect(props.onNudge).toHaveBeenLastCalledWith('b', 1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
  it('reorders by dragging, and says where the step will land', () => {
    const { props } = setup();
    const items = document.querySelectorAll<HTMLElement>('.carousel__item');
    const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    // jsdom has no DragEvent and no layout: give the over-event a pointer position and every item a 100px box.
    items.forEach((item) => { item.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect); });
    const over = (target: HTMLElement, clientX: number) => { const event = createEvent.dragOver(target, { dataTransfer }); Object.defineProperty(event, 'clientX', { value: clientX }); fireEvent(target, event); };
    fireEvent.dragStart(items[0], { dataTransfer });
    over(items[2], 80);
    expect(items[2]).toHaveAttribute('data-drop', 'after');
    fireEvent.drop(items[2], { dataTransfer });
    expect(props.onMove).toHaveBeenCalledWith('a', 2);   // after c, once a has left: position 2
    expect(items[2]).not.toHaveAttribute('data-drop');
    props.onMove.mockClear();
    fireEvent.dragStart(items[3], { dataTransfer }); over(items[0], 10); fireEvent.drop(items[0], { dataTransfer });
    expect(props.onMove).toHaveBeenCalledWith('d', 0);
    props.onMove.mockClear();
    fireEvent.dragStart(items[1], { dataTransfer }); over(items[1], 80); fireEvent.drop(items[1], { dataTransfer });
    expect(props.onMove).not.toHaveBeenCalled();         // dropped where it already is
  });
  it('asks before deleting, and nothing is deleted until the person confirms', async () => {
    const { props } = setup(); const user = userEvent.setup();
    frame(3).focus(); await user.keyboard('{Delete}');
    const dialog = screen.getByRole('alertdialog', { name: '¿Eliminar el paso 3?' });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();   // the safe choice has focus
    await user.keyboard('{Enter}'); expect(props.onDelete).not.toHaveBeenCalled(); expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 4' }));
    expect(screen.getByRole('alertdialog', { name: '¿Eliminar el paso 4?' })).toBeInTheDocument();
    await user.keyboard('{Escape}'); expect(props.onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 4' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    expect(props.onDelete).toHaveBeenCalledWith('d'); await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
  it('keeps the dialog open and says why when the delete fails', async () => {
    const { props } = setup({ onDelete: vi.fn<(stepId: string) => Promise<void>>(async () => { throw new Error('El paso cambió fuera de Paso.'); }) }); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 1' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El paso cambió fuera de Paso.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument(); expect(props.onDelete).toHaveBeenCalledTimes(1);
  });
  it('warns that the last step leaves the scene empty', async () => {
    setup({ stepIds: ['a'], currentId: 'a' }); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 1' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('quedará vacía');
  });
  it('has Añadir and Duplicar pinned beside the strip, and waits while an action runs', async () => {
    const { props, redraw } = setup(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Añadir paso' })); await user.click(screen.getByRole('button', { name: 'Duplicar paso' }));
    expect(props.onAdd).toHaveBeenCalledTimes(1); expect(props.onDuplicate).toHaveBeenCalledTimes(1);
    const actions = document.querySelector('.carousel__actions')!;
    expect(actions.parentElement).toBe(document.querySelector('.carousel')); expect(actions.contains(document.querySelector('.carousel__frames'))).toBe(false);
    redraw({ busy: true });
    expect(screen.getByRole('button', { name: 'Añadir paso' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Duplicar paso' })).toBeDisabled();
    redraw({ stepIds: [], currentId: undefined });
    expect(screen.getByRole('button', { name: 'Duplicar paso' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Añadir paso' })).toBeEnabled();
    expect(screen.getByText('Sin pasos')).toBeInTheDocument();
  });
  it('does not pre-empt keys that carry a modifier', () => {
    const { props } = setup(); frame(2).focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const event = createEvent.keyDown(frame(2), { key: 'ArrowRight', ...init }); fireEvent(frame(2), event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
