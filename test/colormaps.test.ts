import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CMAP_STOPS, steppedGradient } from '../src/webview/colormaps';

test('every offered colormap has 16 hex stops', () => {
  const names = Object.keys(CMAP_STOPS);
  assert.ok(names.length >= 13);
  for (const name of names) {
    assert.equal(CMAP_STOPS[name].length, 16, `${name} should have 16 stops`);
    for (const stop of CMAP_STOPS[name]) {
      assert.match(stop, /^#[0-9a-f]{6}$/, `${name} has a bad stop: ${stop}`);
    }
  }
});

test('steppedGradient builds equal-width hard-stop segments', () => {
  const css = steppedGradient('viridis');
  assert.ok(css.startsWith('linear-gradient(to right, '));
  // 16 stops → segments of 6.25%, first block from 0% to 6.25%.
  assert.ok(css.includes('#440154 0% 6.25%'), css);
  assert.ok(css.includes('#fde725 93.75% 100%'), css);
  // One segment per stop.
  assert.equal(css.split('%,').length, 16);
});

test('steppedGradient returns empty string for an unknown colormap', () => {
  assert.equal(steppedGradient('nope'), '');
});
