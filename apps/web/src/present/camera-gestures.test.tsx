// @vitest-environment jsdom
import { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_ZOOM, type Zoom } from './framing';
import { VIEW_ZOOM_MAX, VIEW_ZOOM_MIN, wheelZoom, zoomViewAt } from './camera-gestures';
import { useCameraGestures } from './use-camera-gestures';

afterEach(cleanup);

function Harness({ onClick = () => {} }: { onClick?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(NO_ZOOM);
  const [motion, setMotion] = useState('camera');
  const direct = useCallback(() => setMotion('none'), []);
  const { panReady, panning } = useCameraGestures(root, zoom, setZoom, direct);
  return <div ref={root} data-testid="surface" data-camera={JSON.stringify(zoom)} data-motion={motion} data-ready={panReady} data-panning={panning} onClick={onClick}>
    <button type="button">Siguiente</button>
  </div>;
}
const surface = () => screen.getByTestId('surface');
const camera = (): Zoom => JSON.parse(surface().getAttribute('data-camera')!);
const pointer = (target: Element | Window, type: string, data: MouseEventInit = {}) => fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, ...data }), { pointerId: 1 }));

describe('the manual presentation camera', () => {
  it('keeps the point under the pointer fixed while zooming in and out after panning', () => {
    const before = { scale: 2, x: 700, y: -400 };
    const point = { x: 300, y: 200 };
    for (const scale of [0.1, 0.5, 1, 5, 30]) {
      const after = zoomViewAt(before, scale, point);
      expect((point.x - after.x) / after.scale).toBeCloseTo((point.x - before.x) / before.scale);
      expect((point.y - after.y) / after.scale).toBeCloseTo((point.y - before.y) / before.scale);
    }
    expect(zoomViewAt(before, -1, point).scale).toBe(VIEW_ZOOM_MIN);
    expect(zoomViewAt(before, 100, point).scale).toBe(VIEW_ZOOM_MAX);
  });
  it('gives small trackpad deltas smaller increments than a mouse wheel', () => {
    const point = { x: 300, y: 200 };
    expect(wheelZoom(NO_ZOOM, -1, point).scale).toBeCloseTo(1.01);
    expect(wheelZoom(NO_ZOOM, -100, point).scale).toBeCloseTo(1.1);
    expect(wheelZoom(NO_ZOOM, 100, point).scale).toBeCloseTo(0.9);
  });
  it.each(['ctrlKey', 'metaKey'])('zooms with %s+wheel, cancels browser zoom and bypasses the camera animation', (modifier) => {
    render(<Harness />);
    expect(fireEvent.wheel(surface(), { [modifier]: true, deltaY: -10, clientX: 200, clientY: 100 })).toBe(false);
    expect(camera().scale).toBeCloseTo(1.1);
    expect(camera().x).toBeCloseTo(-20);
    expect(camera().y).toBeCloseTo(-10);
    expect(surface().getAttribute('data-motion')).toBe('none');
  });
  it('pans freely with scroll, Shift+wheel and line-based wheel events', () => {
    render(<Harness />);
    fireEvent.wheel(surface(), { deltaX: -30, deltaY: 40 });
    expect(camera()).toEqual({ scale: 1, x: 30, y: -40 });
    fireEvent.wheel(surface(), { shiftKey: true, deltaY: 20 });
    expect(camera()).toEqual({ scale: 1, x: 10, y: -40 });
    fireEvent.wheel(surface(), { deltaY: 2, deltaMode: 1 });
    expect(camera().y).toBe(-72);
  });
  it.each([0, 1])('pans with %s as the mouse button, suppresses the drag click and keeps later clicks', (button) => {
    const click = vi.fn();
    render(<Harness onClick={click} />);
    if (button === 0) fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    pointer(surface(), 'pointerdown', { button, clientX: 100, clientY: 100 });
    pointer(window, 'pointermove', { clientX: 160, clientY: 130 });
    expect(camera()).toEqual({ scale: 1, x: 60, y: 30 });
    expect(surface().getAttribute('data-panning')).toBe('true');
    pointer(window, 'pointerup');
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    fireEvent.click(surface());
    expect(click).not.toHaveBeenCalled();
    pointer(surface(), 'pointerdown', { button: 0 });
    fireEvent.click(surface());
    expect(click).toHaveBeenCalledOnce();
  });
  it('keeps buttons out of the gestures and releases Space and the drag on blur', () => {
    render(<Harness />);
    // Clicking a pager can leave focus on a button. Space must still belong to panning.
    expect(fireEvent.keyDown(screen.getByRole('button'), { key: ' ', code: 'Space' })).toBe(false);
    expect(surface().getAttribute('data-ready')).toBe('true');
    pointer(screen.getByRole('button'), 'pointerdown', { button: 0 });
    pointer(window, 'pointermove', { clientX: 60, clientY: 30 });
    expect(camera()).toEqual(NO_ZOOM);
    pointer(surface(), 'pointerdown', { button: 0, clientX: 100, clientY: 100 });
    fireEvent.blur(window);
    pointer(window, 'pointermove', { clientX: 160, clientY: 130 });
    expect(camera()).toEqual(NO_ZOOM);
    expect(surface().getAttribute('data-ready')).toBe('false');
    expect(surface().getAttribute('data-panning')).toBe('false');
  });
  it('supports Safari pinch events and removes all handlers when leaving', () => {
    const { unmount } = render(<Harness />);
    const node = surface();
    const gesture = (type: string, scale: number) => fireEvent(node, Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 200, clientY: 100 }));
    gesture('gesturestart', 1);
    gesture('gesturechange', 1.5);
    expect(camera()).toEqual({ scale: 1.5, x: -100, y: -50 });
    gesture('gesturechange', 0.5);
    expect(camera()).toEqual({ scale: 0.5, x: 100, y: 50 });
    gesture('gestureend', 0.5);
    unmount();
    expect(fireEvent.wheel(node, { ctrlKey: true, deltaY: -10 })).toBe(true);
  });
});
