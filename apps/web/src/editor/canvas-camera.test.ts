import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { fitOpeningDrawing, openingFit } from './canvas-camera';

describe('opening camera', () => {
  it('asks Excalidraw to fit with a 100% cap and room for controls', () => {
    const elements = [{ id: 'drawing', isDeleted: false }];
    const scrollToContent = vi.fn();
    fitOpeningDrawing({ getSceneElements: () => elements, scrollToContent } as unknown as ExcalidrawImperativeAPI);
    expect(scrollToContent).toHaveBeenCalledWith(elements, expect.objectContaining({
      fitToViewport: true, maxZoom: 1, viewportZoomFactor: 0.9,
      canvasOffsets: { top: 72, bottom: 64, left: 24, right: 24 },
    }));
  });

  it('leaves an empty drawing alone', () => {
    const scrollToContent = vi.fn();
    fitOpeningDrawing({ getSceneElements: () => [], scrollToContent } as unknown as ExcalidrawImperativeAPI);
    expect(scrollToContent).not.toHaveBeenCalled();
  });

  it('fits once on opening, never on later changes or a same-step reload', () => {
    const scrollToContent = vi.fn();
    const api = { getSceneElements: () => [{ id: 'a', isDeleted: false }], scrollToContent } as unknown as ExcalidrawImperativeAPI;
    const open = openingFit(false);
    expect(open(api)).toBe(true);
    expect(open(api)).toBe(false);
    expect(scrollToContent).toHaveBeenCalledTimes(1);
    expect(openingFit(true)(api)).toBe(true);
    expect(scrollToContent).toHaveBeenCalledTimes(1);
  });
});
