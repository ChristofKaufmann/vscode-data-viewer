import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_MIN_COL_WIDTH,
  autoWidth,
  cellClass,
  clampDragWidth,
  HEADER_WIDTH_FACTOR,
  isNumericColumn,
  MAX_COL_WIDTH,
  maxChars,
  MIN_COL_WIDTH,
} from '../src/webview/columns';

test('isNumericColumn accepts ints, decimals (point/comma), signs, exponents', () => {
  assert.equal(isNumericColumn(['1', '-2', '3.5', '4,5', '1e9', '-1.2E-3']), true);
});

test('isNumericColumn ignores empty cells but needs at least one value', () => {
  assert.equal(isNumericColumn(['', '7', '']), true);
  assert.equal(isNumericColumn(['', '', '']), false);
  assert.equal(isNumericColumn([]), false);
});

test('isNumericColumn rejects columns with any non-numeric value', () => {
  assert.equal(isNumericColumn(['1', 'x', '3']), false);
  assert.equal(isNumericColumn(['2024-01-01']), false);
});

test('maxChars weights the bold header but counts values at face value', () => {
  // A longer value dominates and is counted at face value.
  assert.equal(maxChars('id', ['1', '100', '5']), 3);
  // A header-dominated column is widened by the bold-header factor.
  assert.equal(maxChars('population', ['1', '2']), 'population'.length * HEADER_WIDTH_FACTOR);
});

test('autoWidth clamps to the auto min/max bounds', () => {
  assert.equal(autoWidth(0), AUTO_MIN_COL_WIDTH);
  assert.equal(autoWidth(1000), MAX_COL_WIDTH);
  assert.equal(autoWidth(10), 10 * 8 + 18);
});

test('clampDragWidth enforces only the hard minimum (no upper cap)', () => {
  assert.equal(clampDragWidth(5), MIN_COL_WIDTH);
  assert.equal(clampDragWidth(1000), 1000);
});

test('cellClass marks column 0 as the sticky index column', () => {
  assert.equal(cellClass('cell', { index: true, numeric: false }), 'cell indexcol');
  assert.equal(cellClass('cell', { index: false, numeric: false }), 'cell');
});

test('cellClass pins the index header to the corner', () => {
  assert.equal(cellClass('cell head', { index: true, numeric: false }), 'cell head indexcol corner');
});

test('cellClass adds num for numeric columns, including the index', () => {
  assert.equal(cellClass('cell', { index: false, numeric: true }), 'cell num');
  assert.equal(cellClass('cell', { index: true, numeric: true }), 'cell num indexcol');
});
