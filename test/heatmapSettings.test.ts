import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHeatmapSettings, updateHeatmapSettings } from '../src/heatmapSettings';

// Minimal stand-in for the bits of ExtensionContext.globalState we use.
function fakeContext(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test('defaults to enabled + viridis + uncentered + global when nothing is saved', () => {
  const s = getHeatmapSettings(fakeContext());
  assert.deepEqual(s, { enabled: true, colormap: 'viridis', center: false, columnwise: false });
});

test('round-trips saved settings', async () => {
  const ctx = fakeContext();
  const saved = { enabled: false, colormap: 'plasma', center: true, columnwise: true };
  await updateHeatmapSettings(ctx, saved);
  assert.deepEqual(getHeatmapSettings(ctx), saved);
});

test('fills in missing fields from a partial saved value', () => {
  const ctx = fakeContext({ 'dataViewer.heatmap': { colormap: 'magma' } });
  assert.deepEqual(getHeatmapSettings(ctx), {
    enabled: true,
    colormap: 'magma',
    center: false,
    columnwise: false,
  });
});
