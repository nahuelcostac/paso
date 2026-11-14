import { describe, expect, it } from 'vitest';
import { unionBounds, type Bounds } from '../editor/thumbnail-bounds';
import { anchorRect, BLEED, MARGIN_MIN, MIN_EXTENT, presentationAnchor, presentationFrame, type Viewport, NO_ZOOM, ZOOM_MAX, zoomAt, cameraZoom } from './framing';

const screens: Viewport[] = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 500, height: 1000 }, { width: 3840, height: 1080 }, { width: 320, height: 480 }];
const onScreen = (point: readonly [number, number], viewport: Viewport, content: Bounds | null) => {
  const { scale, offsetX, offsetY } = presentationFrame(content, viewport);
  return [point[0] * scale + offsetX, point[1] * scale + offsetY];
};

describe('the framing of a presentation', () => {
  // Steps of very different content, as a scene that grows: one small box, then a wide row, then a far note.
  const steps: Bounds[] = [[100, 100, 200, 200], [-400, 100, 1800, 300], [100, 2000, 300, 2100]];
  const content = unionBounds(steps);

  it('comes from all the steps together, so it is the same whichever step is on screen', () => {
    expect(content).toEqual([-400, 100, 1800, 2100]);
    // The union of any subset that holds the extremes gives the same camera, in any order.
    expect(presentationFrame(unionBounds([...steps].reverse()), screens[0])).toEqual(presentationFrame(content, screens[0]));
  });

  it.each(screens)('fits every step inside the margins at $width×$height', (viewport) => {
    const marginX = Math.max(MARGIN_MIN.x, viewport.width * 0.05);
    const marginY = Math.max(MARGIN_MIN.y, viewport.height * 0.06);
    for (const box of steps) {
      const [left, top] = onScreen([box[0], box[1]], viewport, content);
      const [right, bottom] = onScreen([box[2], box[3]], viewport, content);
      expect(left).toBeGreaterThanOrEqual(marginX - 1e-6); expect(right).toBeLessThanOrEqual(viewport.width - marginX + 1e-6);
      expect(top).toBeGreaterThanOrEqual(marginY - 1e-6); expect(bottom).toBeLessThanOrEqual(viewport.height - marginY + 1e-6);
    }
  });

  it.each(screens)('centres the content and touches a margin on one axis at $width×$height', (viewport) => {
    const [left, top] = onScreen([content[0], content[1]], viewport, content);
    const [right, bottom] = onScreen([content[2], content[3]], viewport, content);
    expect((left + right) / 2).toBeCloseTo(viewport.width / 2); expect((top + bottom) / 2).toBeCloseTo(viewport.height / 2);
    const slackX = left - Math.max(MARGIN_MIN.x, viewport.width * 0.05);
    const slackY = top - Math.max(MARGIN_MIN.y, viewport.height * 0.06);
    expect(Math.min(slackX, slackY)).toBeCloseTo(0);
  });

  it('keeps the bottom margin clear of the step indicator, at any size', () => {
    for (const viewport of screens) {
      const [, bottom] = onScreen([content[2], content[3]], viewport, content);
      // The indicator is 16px from the bottom and about 15px tall.
      expect(viewport.height - bottom).toBeGreaterThanOrEqual(31);
    }
  });

  it('does not blow up a tiny scene to the edges of the screen', () => {
    const tiny: Bounds = [0, 0, 20, 10];
    const { scale } = presentationFrame(tiny, { width: 1440, height: 900 });
    expect(scale).toBeCloseTo(Math.min((1440 - 144) / MIN_EXTENT.width, (900 - 108) / MIN_EXTENT.height));
    // It is still centred.
    expect(onScreen([10, 5], { width: 1440, height: 900 }, tiny)).toEqual([720, 450]);
  });

  it('survives a blank scene, a single point and a window too small to hold its margins', () => {
    for (const box of [null, [5, 5, 5, 5] as Bounds]) {
      const frame = presentationFrame(box, { width: 1440, height: 900 });
      expect(frame.scale).toBeGreaterThan(0); expect(Number.isFinite(frame.offsetX + frame.offsetY)).toBe(true);
    }
    const crushed = presentationFrame(content, { width: 10, height: 10 });
    expect(crushed.scale).toBeGreaterThan(0); expect(Number.isFinite(crushed.scale)).toBe(true);
  });

  it('puts every exported drawing in the same place, because they share an anchor', () => {
    const anchor = presentationAnchor(content);
    expect(anchor).toEqual([content[0] - BLEED, content[1] - BLEED, content[2] + BLEED, content[3] + BLEED]);
    for (const viewport of screens) {
      const frame = presentationFrame(content, viewport);
      const rect = anchorRect(anchor, frame);
      // The corner of the anchor is where the camera sends that world point.
      expect(rect.left).toBeCloseTo(anchor[0] * frame.scale + frame.offsetX);
      expect(rect.width).toBeCloseTo((content[2] - content[0] + 2 * BLEED) * frame.scale);
      // A point of the drawing at (x, y) in export coordinates ends up where the camera says.
      const x = 100 - anchor[0]; const y = 100 - anchor[1];
      expect(rect.left + x * frame.scale).toBeCloseTo(onScreen([100, 100], viewport, content)[0]);
      expect(rect.top + y * frame.scale).toBeCloseTo(onScreen([100, 100], viewport, content)[1]);
    }
  });
});

describe('zooming in a presentation', () => {
  const screen = { width: 1000, height: 600 };
  it('keeps the point under the pointer still', () => {
    const zoom = zoomAt(NO_ZOOM, 2, { x: 300, y: 200 }, screen);
    expect(zoom).toEqual({ scale: 2, x: -300, y: -200 });
    expect((300 - zoom.x) / zoom.scale).toBe(300);   // what was at 300 is still at 300
  });
  it('keeps the screen covered near an edge, and never goes past the framing or the maximum', () => {
    // Zooming out from the right edge around the top-left corner would uncover the right of the screen: held at the edge.
    expect(zoomAt({ scale: 2, x: -1000, y: 0 }, 0.75, { x: 0, y: 0 }, screen)).toEqual({ scale: 1.5, x: -500, y: 0 });
    expect(zoomAt({ scale: 2, x: -300, y: -200 }, 1 / 4, { x: 10, y: 10 }, screen)).toEqual(NO_ZOOM);
    expect(zoomAt(NO_ZOOM, 100, { x: 500, y: 300 }, screen).scale).toBe(ZOOM_MAX);
  });
});

describe('a step camera in a presentation', () => {
  const screen = { width: 1000, height: 600 };
  const frame = { scale: 1, offsetX: 0, offsetY: 0 };
  it('fills the screen inside the margins with the camera box, centred', () => {
    const zoom = cameraZoom({ x: 400, y: 200, width: 200, height: 100 }, frame, screen);
    // Available: 900×480 (margins 50 and 60); the box scales by min(900/200, 480/100) = 4.5, under the maximum of 6.
    expect(zoom.scale).toBe(4.5);
    expect(500 * zoom.scale + zoom.x).toBeCloseTo(500);   // the box's centre lands on the screen's centre
    expect(250 * zoom.scale + zoom.y).toBeCloseTo(300);
  });
  it('never zooms out past the framing, never past the maximum, and keeps the screen covered', () => {
    expect(cameraZoom({ x: -1000, y: -1000, width: 5000, height: 5000 }, frame, screen)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(cameraZoom({ x: 500, y: 300, width: 1, height: 1 }, frame, screen).scale).toBe(ZOOM_MAX);
    const corner = cameraZoom({ x: 0, y: 0, width: 100, height: 100 }, frame, screen);
    expect(corner.x).toBe(0); expect(corner.y).toBe(0);
  });
});
