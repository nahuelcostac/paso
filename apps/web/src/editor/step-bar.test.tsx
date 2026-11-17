// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepBar } from './StepBar';

afterEach(cleanup);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
function setup(props: Partial<Parameters<typeof StepBar>[0]> = {}) {
  const all = { stepIds: ids(3), currentId: 's1' as string | undefined, stripShown: true, onToggle: vi.fn<() => void>(), onStep: vi.fn<(delta: -1 | 1) => void>(), ...props };
  const view = render(<StepBar {...all} />);
  return { ...all, rerender: (changes: Partial<typeof all>) => view.rerender(<StepBar {...all} {...changes} />), container: view.container };
}

describe('step bar', () => {
  it('says where you are and moves one step at a time, stopping at both ends', async () => {
    const user = userEvent.setup();
    const { onStep, rerender } = setup();
    expect(screen.getByTestId('step-count')).toHaveTextContent('02 / 03');
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    await user.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
    rerender({ currentId: 's0' });
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
    rerender({ currentId: 's2' });
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
  });

  it('keeps one toggle whose label follows the strip, without changing its text', async () => {
    const user = userEvent.setup();
    const { onToggle, rerender } = setup();
    const toggle = screen.getByRole('button', { name: 'Hide steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent(/^Steps$/);
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender({ stripShown: false });
    expect(screen.getByRole('button', { name: 'Show steps' })).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/^Steps$/);
  });

  it('shows the steps as ticks only while the strip is hidden, and only up to 24', () => {
    const { rerender, container } = setup();
    const ticks = () => container.querySelectorAll('.step-bar__ticks i');
    expect(ticks()).toHaveLength(0);
    rerender({ stripShown: false });
    expect(ticks()).toHaveLength(3);
    expect(container.querySelector('.step-bar__ticks i.on')).toBe(ticks()[1]);
    rerender({ stripShown: false, stepIds: ids(25), currentId: 's0' });
    expect(ticks()).toHaveLength(0);
    expect(screen.getByTestId('step-count')).toHaveTextContent('01 / 25');
  });

  it('has no pager for a single step, only the toggle', () => {
    setup({ stepIds: ['s0'], currentId: 's0', stripShown: false });
    expect(screen.queryByRole('group', { name: 'Step navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show steps' })).toBeInTheDocument();
  });
});
