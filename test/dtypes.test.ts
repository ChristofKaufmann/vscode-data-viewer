import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dtypeGlyph } from '../src/webview/dtypes';

test('maps known kinds to distinct glyphs', () => {
  const kinds = ['numeric', 'text', 'bool', 'datetime', 'timedelta', 'categorical'];
  const glyphs = kinds.map(dtypeGlyph);
  assert.equal(glyphs[0], '#');
  // All distinct.
  assert.equal(new Set(glyphs).size, kinds.length);
});

test('falls back to the "other" glyph for unknown kinds', () => {
  assert.equal(dtypeGlyph('something-else'), dtypeGlyph('other'));
});

test('glyphs are single BMP characters (no emoji-range codepoints)', () => {
  for (const kind of ['numeric', 'text', 'bool', 'datetime', 'timedelta', 'categorical', 'other']) {
    const g = dtypeGlyph(kind);
    assert.equal([...g].length, 1, `${kind} glyph should be one character`);
    assert.ok(g.codePointAt(0)! <= 0xffff, `${kind} glyph should be in the BMP`);
  }
});
