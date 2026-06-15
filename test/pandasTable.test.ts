import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDumpCode,
  csvReadExpression,
  DumpPayload,
  parsePayload,
  toTable,
} from '../src/pandasTable';

function payload(over: Partial<DumpPayload> = {}): DumpPayload {
  return {
    total: 2,
    indexName: '',
    table: { columns: ['a', 'b'], index: [0, 1], data: [[1, 'x'], [2, 'y']] },
    colors: null,
    columnTypes: null,
    ...over,
  };
}

test('toTable always prepends the index as column 0', () => {
  const { columns, rows } = toTable(payload());
  assert.deepEqual(columns, ['', 'a', 'b']);
  assert.deepEqual(rows, [
    ['0', '1', 'x'],
    ['1', '2', 'y'],
  ]);
});

test('toTable prepends a null index color, aligning colors with rows', () => {
  const { colors } = toTable(
    payload({ colors: [['#111111', null], [null, '#222222']] })
  );
  assert.deepEqual(colors, [
    [null, '#111111', null],
    [null, null, '#222222'],
  ]);
});

test('toTable passes through null colors (no heatmap)', () => {
  assert.equal(toTable(payload({ colors: null })).colors, null);
});

test('toTable passes column types through (already index-aligned)', () => {
  const columnTypes = [
    { dtype: 'int64', kind: 'numeric' },
    { dtype: 'float64', kind: 'numeric' },
    { dtype: 'object', kind: 'text' },
  ];
  assert.deepEqual(toTable(payload({ columnTypes })).columnTypes, columnTypes);
});

test('toTable uses the index name as the first header when named', () => {
  const { columns } = toTable(
    payload({ indexName: 'id', table: { columns: ['v'], index: ['r1'], data: [[1]] } })
  );
  assert.equal(columns[0], 'id');
});

test('toTable leaves the index header blank when unnamed', () => {
  const { columns } = toTable(payload({ indexName: '' }));
  assert.equal(columns[0], '');
});

test('toTable formats null/undefined as empty strings', () => {
  const { rows } = toTable(
    payload({ table: { columns: ['a', 'b'], index: [0], data: [[null, undefined]] } })
  );
  assert.deepEqual(rows[0], ['0', '', '']);
});

test('toTable JSON-stringifies object cells (e.g. dict/list values)', () => {
  const { rows } = toTable(payload({ table: { columns: ['a'], index: [0], data: [[{ k: 1 }]] } }));
  assert.equal(rows[0][1], '{"k":1}');
});

test('toTable stringifies datetime/number index values', () => {
  const { rows } = toTable(
    payload({ table: { columns: ['v'], index: ['2024-01-01T00:00:00.000'], data: [[1.5]] } })
  );
  assert.equal(rows[0][0], '2024-01-01T00:00:00.000');
});

test('toTable adds a truncation note only when rows were dropped', () => {
  const truncated = toTable(
    payload({ total: 1000, table: { columns: ['a'], index: [0, 1], data: [[1], [2]] } })
  );
  // Mirror the implementation's own locale formatting so the assertion holds
  // on any machine locale.
  const shown = (2).toLocaleString();
  const total = (1000).toLocaleString();
  assert.equal(truncated.note, `showing first ${shown} of ${total} rows`);

  const full = toTable(payload({ total: 2 }));
  assert.equal(full.note, undefined);
});

test('parsePayload reads a clean JSON line', () => {
  const text = JSON.stringify(payload());
  assert.equal(parsePayload(text).total, 2);
});

test('parsePayload falls back to the last non-empty line past stray output', () => {
  const text = `a warning was printed\n\n${JSON.stringify(payload())}\n`;
  assert.equal(parsePayload(text).indexName, '');
});

test('parsePayload throws on empty output', () => {
  assert.throws(() => parsePayload('   \n  '), /no data/);
});

test('csvReadExpression escapes paths as valid Python/JSON string literals', () => {
  assert.equal(csvReadExpression('/tmp/a.csv'), '_read_csv("/tmp/a.csv")');
  // Backslashes and quotes must be escaped so the generated code stays valid.
  assert.equal(
    csvReadExpression('C:\\data\\"weird".csv'),
    '_read_csv("C:\\\\data\\\\\\"weird\\".csv")'
  );
});

test('buildDumpCode embeds the expression and the index-name logic', () => {
  const code = buildDumpCode('my_var');
  assert.match(code, /obj = my_var/);
  assert.match(code, /to_json\(orient="split"/);
  // Index header is built from index.names so a MultiIndex gets a header too,
  // joined with ", " and blank when no level is named.
  assert.match(code, /head\.index\.names/);
  assert.match(code, /", "\.join/);
  // Datetimes/timedeltas are stringified like str() rather than left to
  // to_json's ISO format.
  assert.match(code, /is_datetime64_any_dtype/);
  assert.match(code, /None if pd\.isna\(x\) else str\(x\)/);
  // Heatmap colors are computed in Python via matplotlib, resiliently.
  assert.match(code, /matplotlib/);
  assert.match(code, /colormaps\["viridis"\]/);
  assert.match(code, /"colors": %s/);
  // A chosen colormap is injected safely as a JSON/Python string literal.
  assert.match(buildDumpCode('x', { colormap: 'plasma' }), /colormaps\["plasma"\]/);
  // The heatmap options are injected as Python booleans.
  assert.match(buildDumpCode('x', { center: true }), /_center = True/);
  assert.match(buildDumpCode('x', { center: false }), /_center = False/);
  assert.match(buildDumpCode('x', { columnwise: true }), /_columnwise = True/);
  assert.match(buildDumpCode('x', { colorizeNumeric: false }), /_do_num = False/);
  assert.match(buildDumpCode('x', { colorizeDatetime: false }), /_do_dt = False/);
  assert.match(buildDumpCode('x', { colorizeCategorical: false }), /_do_cat = False/);
  // Defaults: all column types are colorized.
  assert.match(code, /_do_num = True/);
  assert.match(code, /_do_dt = True/);
  assert.match(code, /_do_cat = True/);
  // Datetime columns are colored from their epoch values (separate group).
  assert.match(code, /_np\.isnat/);
  assert.match(code, /_hi = max\(abs\(_lo\), abs\(_hi\)\)/);
  assert.match(code, /"datetime" if .* else "timedelta"/);
  // Ordered categoricals are colored by code over a fixed 0..n-1 range.
  assert.match(code, /_c\.dtype\.ordered/);
  assert.match(code, /_c\.cat\.codes/);
  // Centering is skipped for datetimes (arbitrary epoch) and categoricals.
  assert.match(code, /_center and _grp\[_i\] not in \("datetime", "categorical"\)/);
  // Per-column dtype + kind are computed for the type glyphs.
  assert.match(code, /"columnTypes": %s/);
  assert.match(code, /def _kind\(_x\):/);
  // Sorting: empty by default; a stable multi-key sort_values when keys given.
  assert.match(code, /_sort = \[\]/);
  const sorted = buildDumpCode('df', { sort: [{ column: 2, descending: true }, { column: 0, descending: false }] });
  assert.match(sorted, /_sort = \[\(2, True\), \(0, False\)\]/);
  assert.match(sorted, /sort_values\(by=\[_c for _c, _d in _sort\]/);
  assert.match(sorted, /kind="stable", na_position="last"/);
  // Regression guards: no old single-name default, no dropped showIndex field.
  assert.doesNotMatch(code, /else "index"/);
  assert.doesNotMatch(code, /showIndex/);
});

test('buildDumpCode reads CSV files via the delimiter-sniffing helper', () => {
  const code = buildDumpCode(csvReadExpression('/tmp/x.csv'));
  assert.match(code, /def _read_csv/);
  assert.match(code, /Sniffer\(\)\.sniff/);
  assert.match(code, /obj = _read_csv\("\/tmp\/x\.csv"\)/);
});
