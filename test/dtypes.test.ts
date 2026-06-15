import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dtypeGlyph } from '../src/webview/dtypes';

test('maps the codicon-backed kinds to distinct icon names', () => {
  assert.deepEqual(dtypeGlyph('numeric'), { codicon: 'symbol-numeric' });
  assert.deepEqual(dtypeGlyph('text'), { codicon: 'symbol-string' });
  assert.deepEqual(dtypeGlyph('bool'), { codicon: 'symbol-boolean' });
  assert.deepEqual(dtypeGlyph('datetime'), { codicon: 'clockface' });
  assert.deepEqual(dtypeGlyph('categorical'), { codicon: 'symbol-misc' });

  const icons = ['numeric', 'text', 'bool', 'datetime', 'categorical'].map(
    (k) => dtypeGlyph(k).codicon
  );
  assert.equal(new Set(icons).size, icons.length, 'icon names must be distinct');
});

test('timedelta keeps the text glyph Δ', () => {
  assert.deepEqual(dtypeGlyph('timedelta'), { text: 'Δ' });
});

test('unknown kinds fall back to the "other" text glyph', () => {
  assert.deepEqual(dtypeGlyph('mystery'), dtypeGlyph('other'));
  assert.equal(dtypeGlyph('other').text, '·');
});
