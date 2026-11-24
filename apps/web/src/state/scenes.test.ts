// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../lib/api';
import type { SceneEnvelope } from '../editor/step-actions';
import { useScenes } from './scenes';

const envelope = (id: string, stepIds: string[]) => ({ document: { id, name: id, stepIds }, revision: `${id}-${stepIds.length}` }) as unknown as SceneEnvelope;

describe('useScenes', () => {
  it('ends a re-read only once the newest one is shown, so a step just made is in the list', async () => {
    // Each read answers when the test says so.
    const answers: Array<(scenes: SceneEnvelope[]) => void> = [];
    const api = { listScenes: () => new Promise<SceneEnvelope[]>((resolve) => { answers.push(resolve); }) } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ revision }) => useScenes(api, 'p', revision), { initialProps: { revision: 'r1' } });
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { answers[0]([envelope('s', ['a'])]); });
    expect(result.current.scenes?.[0].document.stepIds).toEqual(['a']);

    // A step is made, and its caller re-reads; the project's new revision starts a newer read before that answers.
    let done = false;
    let own!: Promise<SceneEnvelope[]>;
    act(() => { own = result.current.refresh(); void own.then(() => { done = true; }); });
    rerender({ revision: 'r2' });
    await waitFor(() => expect(answers).toHaveLength(3));
    await act(async () => { answers[1]([envelope('s', ['a', 'b'])]); });
    // The older answer is not applied, so the caller must not go on yet.
    expect(done).toBe(false);
    expect(result.current.scenes?.[0].document.stepIds).toEqual(['a']);
    await act(async () => { answers[2]([envelope('s', ['a', 'b'])]); });
    expect((await own)[0].document.stepIds).toEqual(['a', 'b']);
    expect(result.current.scenes?.[0].document.stepIds).toEqual(['a', 'b']);
  });

  it('does not wait for a read of another project', async () => {
    const answers: Array<(scenes: SceneEnvelope[]) => void> = [];
    const api = { listScenes: () => new Promise<SceneEnvelope[]>((resolve) => { answers.push(resolve); }) } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ projectId }) => useScenes(api, projectId, 'r'), { initialProps: { projectId: 'p' } });
    await waitFor(() => expect(answers).toHaveLength(1));
    const own = result.current.refresh();
    rerender({ projectId: 'q' });
    await waitFor(() => expect(answers).toHaveLength(3));
    await act(async () => { answers[0]([]); answers[1]([envelope('s', ['a'])]); });
    expect((await own)[0].document.id).toBe('s');
  });
});
