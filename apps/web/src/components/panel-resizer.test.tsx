// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_WIDTH, PanelResizer, useAgentWidth } from './PanelResizer';

function Chat({ projectsOpen = true }: { projectsOpen?: boolean }) {
  const width = useAgentWidth(projectsOpen, false);
  return <div data-testid="app" style={{ '--panel-agent': `${width.width}px` } as React.CSSProperties}>
    <aside id="agent-panel"><PanelResizer width={width.width} min={width.min} max={width.max} onChange={width.choose} controls="agent-panel" /></aside>
  </div>;
}
const handle = () => screen.getByRole('separator', { name: 'Anchura del chat' });
const now = () => Number(handle().getAttribute('aria-valuenow'));

// jsdom has no PointerEvent: a mouse event with a pointer id is all the handle reads.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
}
window.PointerEvent ??= FakePointerEvent as unknown as typeof PointerEvent;

beforeEach(() => { window.localStorage.clear(); window.innerWidth = 1440; });
afterEach(cleanup);

describe('the chat width', () => {
  it('starts at 360px, and the arrow keys move the edge: left widens, right narrows, Shift takes bigger steps', async () => {
    const user = userEvent.setup();
    render(<Chat />);
    expect(now()).toBe(AGENT_WIDTH.initial);
    expect(screen.getByTestId('app').style.getPropertyValue('--panel-agent')).toBe('360px');
    handle().focus();
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe(376);
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(now()).toBe(320);   // 376 - 64 would be under the minimum
    expect(screen.getByTestId('app').style.getPropertyValue('--panel-agent')).toBe(`${now()}px`);
  });

  it('stays between 320px and 720px, and never takes the 440px the board keeps', async () => {
    const user = userEvent.setup();
    render(<Chat />);
    handle().focus();
    await user.keyboard('{Home}');
    expect(now()).toBe(320);
    await user.keyboard('{End}');
    expect(now()).toBe(720);   // 1440 - 240 projects - 440 board leaves 760: the cap wins
    cleanup();
    window.innerWidth = 1100;
    render(<Chat />);
    expect(handle()).toHaveAttribute('aria-valuemax', '420');   // 1100 - 240 - 440
    expect(now()).toBe(420);   // the remembered 720 shows narrower, and is not forgotten
    cleanup();
    window.innerWidth = 1440;
    render(<Chat projectsOpen={false} />);
    expect(now()).toBe(720);
  });

  it('follows a drag of its edge, is remembered, and a double click goes back to the start', () => {
    const { unmount } = render(<Chat />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000, pointerId: 1 });
    expect(document.documentElement).toHaveAttribute('data-resizing', 'true');
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 });
    expect(now()).toBe(460);
    fireEvent.pointerUp(handle(), { clientX: 900, pointerId: 1 });
    expect(document.documentElement).not.toHaveAttribute('data-resizing');
    fireEvent.pointerMove(handle(), { clientX: 700, pointerId: 1 });   // no longer dragging
    expect(now()).toBe(460);
    unmount();
    render(<Chat />);
    expect(now()).toBe(460);
    fireEvent.doubleClick(handle());
    expect(now()).toBe(360);
  });
});
