import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexModels, fallbackModels, parseModels } from './codex-models.js';

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
      const script = join(dir, 'codex');
      await writeFile(script, '#!/bin/sh\nexec sleep 10\n'); await chmod(script, 0o700);
      const start = Date.now();
      expect(await discoverCodexModels(script, 100)).toEqual(fallbackModels);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
