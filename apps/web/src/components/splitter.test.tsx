// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_WIDTH, FOLDED, PROJECTS_WIDTH, Splitter, useAgentWidth, useProjectsWidth } from './Splitter';

function Chat({ left = PROJECTS_WIDTH.initial }: { left?: number }) {
  const width = useAgentWidth(left, false);
  const [open, setOpen] = useState(true);
  return <div data-testid="app" data-open={open} style={{ '--panel-agent': `${width.width}px` } as React.CSSProperties}>
    <Splitter side="right" open={open} onToggle={() => setOpen(!open)} hide="Ocultar el agente" show="Mostrar el agente" controls="agent-panel" label="Anchura del chat" resize={width} />
  </div>;
}
function Sidebar() {
  const width = useProjectsWidth();
  const [open, setOpen] = useState(true);
  return <div data-testid="app" data-open={open}>
    <Splitter side="left" open={open} onToggle={() => setOpen(!open)} hide="Ocultar diagramas" show="Mostrar diagramas" controls="projects-panel" label="Anchura de los diagramas" resize={width} />
  </div>;
}
const handle = (name = 'Anchura del chat') => screen.getByRole('separator', { name });
const now = (name?: string) => Number(handle(name).getAttribute('aria-valuenow'));
const open = () => screen.getByTestId('app').dataset.open;

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
    render(<Chat left={300} />);
    expect(now()).toBe(360);   // a wider sidebar leaves less: 1100 - 300 - 440
    cleanup();
    window.innerWidth = 1440;
    render(<Chat left={FOLDED} />);
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

describe('the tab on the edge', () => {
  it('folds and unfolds the panel, with a chevron that points the way it goes', async () => {
    const user = userEvent.setup();
    render(<Chat />);
    const tab = screen.getByRole('button', { name: 'Ocultar el agente' });
    expect(tab).toHaveAttribute('aria-expanded', 'true');
    expect(tab).toHaveAttribute('aria-controls', 'agent-panel');
    expect(tab.querySelector('svg')).toHaveClass('lucide-chevron-right');
    await user.click(tab);
    expect(open()).toBe('false');
    expect(tab).toHaveAccessibleName('Mostrar el agente');
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    expect(tab.querySelector('svg')).toHaveClass('lucide-chevron-left');
    expect(handle()).toHaveAttribute('aria-valuetext', 'Plegado');
    await user.click(tab);
    expect(open()).toBe('true');
  });

  it('folds the panel when its edge is dragged well past the narrowest width, and opens it when dragged back out', () => {
    render(<Chat />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 1060, pointerId: 1 });   // 300px: still open, at the narrowest
    expect(open()).toBe('true');
    expect(now()).toBe(320);
    fireEvent.pointerMove(handle(), { clientX: 1130, pointerId: 1 });   // 230px: more than 80px under it
    expect(open()).toBe('false');
    fireEvent.pointerMove(handle(), { clientX: 1100, pointerId: 1 });   // back out: open again
    expect(open()).toBe('true');
    expect(now()).toBe(320);
    fireEvent.pointerMove(handle(), { clientX: 950, pointerId: 1 });
    expect(now()).toBe(410);
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    // Folded, a drag out of the edge opens it.
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar el agente' }));
    expect(open()).toBe('false');
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1300, pointerId: 2 });
    fireEvent.pointerMove(handle(), { clientX: 1295, pointerId: 2 });   // a nudge is not enough
    expect(open()).toBe('false');
    fireEvent.pointerMove(handle(), { clientX: 1200, pointerId: 2 });
    expect(open()).toBe('true');
  });

  it('folds and unfolds with Enter on the edge', async () => {
    const user = userEvent.setup();
    render(<Chat />);
    handle().focus();
    await user.keyboard('{Enter}');
    expect(open()).toBe('false');
    await user.keyboard('{ArrowRight}');   // narrower: nothing to fold further
    expect(open()).toBe('false');
    await user.keyboard('{ArrowLeft}');
    expect(open()).toBe('true');
    expect(now()).toBe(360);
  });
});

describe('the sidebar width', () => {
  it('starts at 240px, widens to the right up to 420px, and folds when dragged to the left', async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    const name = 'Anchura de los diagramas';
    expect(now(name)).toBe(PROJECTS_WIDTH.initial);
    expect(screen.getByRole('button', { name: 'Ocultar diagramas' }).querySelector('svg')).toHaveClass('lucide-chevron-left');
    handle(name).focus();
    await user.keyboard('{ArrowRight}');
    expect(now(name)).toBe(256);
    await user.keyboard('{End}');
    expect(now(name)).toBe(420);
    await user.keyboard('{Home}');
    expect(now(name)).toBe(200);
    fireEvent.pointerDown(handle(name), { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(handle(name), { clientX: 280, pointerId: 1 });
    expect(now(name)).toBe(280);
    fireEvent.pointerMove(handle(name), { clientX: 100, pointerId: 1 });
    expect(open()).toBe('false');
    fireEvent.pointerUp(handle(name), { pointerId: 1 });
    expect(screen.getByRole('button', { name: 'Mostrar diagramas' }).querySelector('svg')).toHaveClass('lucide-chevron-right');
    cleanup();
    render(<Sidebar />);
    expect(now(name)).toBe(280);   // remembered
  });
});
