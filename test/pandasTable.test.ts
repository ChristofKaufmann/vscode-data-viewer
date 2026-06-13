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
