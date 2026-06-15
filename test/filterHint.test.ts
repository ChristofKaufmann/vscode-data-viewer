import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPlaceholder } from '../src/webview/filterHint';
import { ColumnType } from '../src/shared/protocol';

const t = (kind: string): ColumnType => ({ dtype: kind, kind });

test('numeric value clause: > 0, plus notna and an index clause', () => {
  const out = filterPlaceholder(['', 'founded', 'city'], [t('numeric'), t('numeric'), t('text')], []);
  assert.equal(out, 'Filter rows, e.g.  index > 1 | (city.notna() & founded > 0)');
});

test('datetime value clause when there is no numeric column', () => {
  const out = filterPlaceholder(['', 'event', 'name'], [t('datetime'), t('datetime'), t('text')], []);
  assert.equal(out, "Filter rows, e.g.  index > 1 | (name.notna() & event > '1986-06-30')");
});

test('timedelta value clause when there is no numeric/datetime column', () => {
  const out = filterPlaceholder(['', 'task', 'elapsed'], [t('text'), t('text'), t('timedelta')], []);
  assert.equal(out, "Filter rows, e.g.  index > 1 | (task.notna() & elapsed < '1 days 01:23:45')");
});

test('fallback: last column != its first sample value', () => {
  const out = filterPlaceholder(
    ['', 'city', 'country'],
    [t('text'), t('text'), t('text')],
    [['0', 'Berlin', 'Germany']]
  );
  assert.equal(out, "Filter rows, e.g.  index > 1 | (city.notna() & country != 'Germany')");
});

test('backticks non-identifier names and drops the group for a single column', () => {
  const out = filterPlaceholder(['', 'area km2'], [t('text'), t('numeric')], []);
  assert.equal(out, 'Filter rows, e.g.  index > 1 | `area km2` > 0');
});

test('backticks column names that are Python keywords', () => {
  const out = filterPlaceholder(['', 'class', 'in'], [t('text'), t('numeric'), t('text')], []);
  assert.equal(out, 'Filter rows, e.g.  index > 1 | (`in`.notna() & `class` > 0)');
});

test('generic hint when there are no data columns', () => {
  assert.equal(filterPlaceholder([''], [t('text')], []), 'Filter rows with a pandas query expression');
});

test('without dtype info, falls back to the last column and its first value', () => {
  const out = filterPlaceholder(['', 'a', 'b'], null, [['0', 'x', 'y']]);
  assert.equal(out, "Filter rows, e.g.  index > 1 | (a.notna() & b != 'y')");
});
