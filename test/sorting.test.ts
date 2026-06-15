import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleSort, sortState } from '../src/webview/sorting';

test('first click adds the column as primary (ascending)', () => {
  assert.deepEqual(cycleSort([], 2), [{ column: 2, descending: false }]);
});

test('a newly sorted column becomes primary, demoting the rest', () => {
  const after = cycleSort([{ column: 2, descending: false }], 5);
  assert.deepEqual(after, [
    { column: 5, descending: false },
    { column: 2, descending: false },
  ]);
});

test('second click flips direction in place (keeps its priority)', () => {
  const keys = [
    { column: 5, descending: false },
    { column: 2, descending: false },
  ];
  assert.deepEqual(cycleSort(keys, 2), [
    { column: 5, descending: false },
    { column: 2, descending: true },
  ]);
});

test('third click removes the column from the sort', () => {
  const keys = [
    { column: 5, descending: false },
    { column: 2, descending: true },
  ];
  assert.deepEqual(cycleSort(keys, 2), [{ column: 5, descending: false }]);
});

test('sortState reports direction and 1-based priority', () => {
  const keys = [
    { column: 5, descending: false },
    { column: 2, descending: true },
  ];
  assert.deepEqual(sortState(keys, 5), { dir: 'asc', rank: 1 });
  assert.deepEqual(sortState(keys, 2), { dir: 'desc', rank: 2 });
  assert.deepEqual(sortState(keys, 9), { dir: 'none', rank: 0 });
});
