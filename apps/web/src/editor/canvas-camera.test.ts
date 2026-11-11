import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { cameraKey, fitOpeningDrawing, openingFit } from './canvas-camera';

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

  it('belongs to the scene, so moving between its steps keeps it', () => {
    expect(cameraKey({ projectId: 'p', sceneId: 's', stepId: 'one' })).toBe(cameraKey({ projectId: 'p', sceneId: 's', stepId: 'two' }));
    expect(cameraKey({ projectId: 'p', sceneId: 's', stepId: 'one' })).not.toBe(cameraKey({ projectId: 'p', sceneId: 'other', stepId: 'one' }));
  });

  it('fits the scene\'s frame with the step, so every step of the scene opens framed alike', () => {
    const step = [{ id: 'drawing', isDeleted: false }];
    const frame = [{ id: 'frame' }] as unknown as readonly ExcalidrawElement[];
    const scrollToContent = vi.fn();
    const api = { getSceneElements: () => step, scrollToContent } as unknown as ExcalidrawImperativeAPI;
    openingFit(false, () => frame)(api);
    expect(scrollToContent).toHaveBeenCalledWith([...frame, ...step], expect.objectContaining({ fitToViewport: true }));
    // An empty step still opens on the scene's frame.
    scrollToContent.mockClear();
    fitOpeningDrawing({ getSceneElements: () => [], scrollToContent } as unknown as ExcalidrawImperativeAPI, frame);
    expect(scrollToContent).toHaveBeenCalledWith([...frame], expect.anything());
  });
});
