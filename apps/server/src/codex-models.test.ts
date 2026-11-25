import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexModels, fallbackModels, parseModels } from './codex-models.js';
import { fakePath, writeLauncher } from './agent/testing/launcher.js';

describe('Codex model discovery', () => {
  it('parses models and supported levels and ignores invalid entries', () => {
    expect(parseModels([{ model: 'example', displayName: 'Example', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'unknown' }] }, {}]))
      .toEqual([{ id: 'example', label: 'Example', isDefault: true, efforts: ['high'] }]);
    expect(parseModels(null)).toEqual([]);
  });
  it('falls back when the process fails', async () => {
    expect(await discoverCodexModels('/missing/paso-codex')).toEqual(fallbackModels);
  });
  it('times out and returns the fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paso-model-test-'));
    try {
      const script = await writeLauncher(fakePath(join(dir, 'codex')), 'setInterval(() => {}, 1000)');
      const start = Date.now();
      expect(await discoverCodexModels(script, 100)).toEqual(fallbackModels);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
