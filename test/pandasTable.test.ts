import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDumpCode,
  csvReadExpression,
  featherReadExpression,
  HIST_BINS,
  jsonLinesReadExpression,
  parquetReadExpression,
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
    stats: null,
    filterHint: null,
    filterError: null,
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

test('toTable passes through null colors (Colorize off)', () => {
  assert.equal(toTable(payload({ colors: null })).colors, null);
});

test('toTable passes the filter error through', () => {
  assert.equal(toTable(payload()).filterError, null);
  assert.equal(toTable(payload({ filterError: "name 'nope' is not defined" })).filterError, "name 'nope' is not defined");
});

test('toTable passes the filter-hint expression through', () => {
  assert.equal(toTable(payload({ filterHint: "'Paris'" })).filterHint, "'Paris'");
  assert.equal(toTable(payload()).filterHint, null);
});

test('toTable passes column stats and the full total through (index-aligned)', () => {
  const stats = [{ missing: 0 }, { missing: 3 }, { missing: 1 }];
  const out = toTable(payload({ stats, total: 1000 }));
  assert.deepEqual(out.stats, stats);
  assert.equal(out.total, 1000);
  // Null stats survive as null (source couldn't compute them).
  assert.equal(toTable(payload({ stats: null })).stats, null);
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
  // Cell colors are computed in Python via matplotlib, resiliently.
  assert.match(code, /matplotlib/);
  assert.match(code, /colormaps\["viridis"\]/);
  assert.match(code, /"colors": %s/);
  // A chosen colormap is injected safely as a JSON/Python string literal.
  assert.match(buildDumpCode('x', { colormap: 'plasma' }), /colormaps\["plasma"\]/);
  // The Colorize options are injected as Python booleans.
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
  // Per-column missing-value counts, computed over the full filtered frame
  // (before head truncation) and aligned index-first.
  assert.match(code, /"stats": %s/);
  assert.match(code, /pd\.isna\(_x\)\.sum\(\)/);
  assert.match(code, /stats = \[\{"missing": _missing\(obj\.index\)\}\]/);
  // Stats are counted before the head() truncation so they stay exact.
  assert.ok(code.indexOf('_missing(obj.index)') < code.indexOf(`head = obj.head(`));
  // Numeric (non-bool) columns get a histogram via numpy over non-null values,
  // binned on a "nice" rounded grid (step from range/HIST_BINS), attached when
  // computable. HIST_BINS is injected as the Python `_HB`.
  assert.match(code, new RegExp(`_HB = ${HIST_BINS}`));
  assert.match(code, /_v\[_np\.isfinite\(_v\)\]/);
  assert.match(code, /_nice\(\(_hi - _lo\) \/ _HB, True\)/);
  assert.match(code, /_np\.floor\(_lo \/ _step\) \* _step/);
  assert.match(code, /_np\.histogram\(_v, bins=_edges\)/);
  assert.match(code, /"edges": \[round\(float\(_e\), _dec\)/);
  assert.match(code, /_md = float\(_np\.median\(_v\)\)/);
  assert.match(code, /"min": _sig\(_lo\), "median": _sig\(_md\), "max": _sig\(_hi\)/);
  assert.match(code, /_entry\["histogram"\] = _h/);
  // Datetime/timedelta also get a histogram, with calendar-/duration-aware edges
  // and date/duration label strings (positions normalized to ns first).
  assert.match(code, /def _date_edges\(_lo, _hi\):/);
  assert.match(code, /pd\.date_range\(start=_start, end=_hi, freq=_freq\)/);
  assert.match(code, /def _td_step\(_span\):/);
  assert.match(code, /_vv\.astype\("datetime64\[ns\]"\)\.astype\("int64"\)/);
  assert.match(code, /_vv\.astype\("timedelta64\[ns\]"\)\.astype\("int64"\)/);
  assert.match(code, /"labels": \{"edges": _elabels/);
  // Histogram bars are tinted by their bin center on the colormap, using the same
  // range as the cell coloring: per-column when columnwise, else shared across the
  // type group, and centered at 0 for numeric/timedelta (not datetime).
  assert.match(code, /def _bin_colors\(_edges, _lo, _hi\):/);
  assert.match(code, /_ctr = \(float\(_edges\[_j\]\) \+ float\(_edges\[_j \+ 1\]\)\) \/ 2/);
  assert.match(code, /_h\["colors"\] = _bin_colors\(_h\["edges"\], _lo, _hi\)/);
  assert.match(code, /if _columnwise:/);
  assert.match(code, /if _center and _g != "datetime":/);
  // A histogram is colored only when its type's Colorize toggle is on, so turning
  // Colorize off leaves the bars uncolored (like the cells).
  assert.match(code, /_g == "num" and not _do_num.*_g in \("datetime", "timedelta"\) and not _do_dt/);
  assert.match(buildDumpCode('x', { colorizeNumeric: false }), /_do_num = False/);
  // Ordered-categorical bars are likewise tinted only when categorical Colorize is
  // on (the stacked-bar segments stay colored — a single-color bar is unreadable).
  assert.match(code, /_colors = None\n.*if _do_cat:\n.*try:/);
  // center/columnwise are injected into the stats block too (not just the colors
  // block), so the histogram range tracks the cell-coloring range — both appear.
  const centered = buildDumpCode('x', { center: true, columnwise: true });
  assert.equal((centered.match(/_center = True/g) ?? []).length, 2);
  assert.equal((centered.match(/_columnwise = True/g) ?? []).length, 2);
  // Ordered-categorical columns get a bar-per-category (in category order) with
  // colormap colors; attached only when the column isn't numeric.
  assert.match(code, /def _bars\(_c\):/);
  assert.match(code, /_c\.dtype\.ordered/);
  assert.match(code, /_vc = _c\.value_counts\(\)/);
  assert.match(code, /_counts = \[int\(_vc\.get\(_k, 0\)\) for _k in _cats\]/);
  assert.match(code, /_entry\["bars"\] = _b/);
  // Bars use the same colormap as Colorize.
  assert.match(buildDumpCode('x', { colormap: 'plasma' }), /_cm = _mpl\.colormaps\["plasma"\]/);
  // Unordered/text/bool columns: a shared _nominal_info builds both the stacked
  // bar segments and a value->color map (vmap) for cell coloring.
  assert.match(code, /def _nominal_info\(_c\):/);
  assert.match(code, /_vc = _c\.value_counts\(dropna=True\)/);
  assert.match(code, /colormaps\["tab10"\]/);
  // Values are kept a whole count-level at a time against a 9-color budget; a
  // level that overflows (and everything rarer) collapses into "(other)". The
  // palette skips tab10's C7 (gray) so it can't clash with the "(other)" gray.
  assert.match(code, /_budget = 9/);
  assert.match(code, /if _i \+ _budget < _n and _cv\[_i \+ _budget\] == _lvl:/);
  assert.match(code, /_palidx = \[0, 1, 2, 3, 4, 5, 6, 8, 9\]/);
  assert.match(code, /_vmap = \{str\(_vc\.index\[_k\]\): _hex\[_k\] for _k in range\(_keep\)\}/);
  assert.match(code, /"unique": int\(_vc\.size\)/);
  assert.match(code, /"allUnique": bool\(_cv\[0\] == 1\)/);
  assert.match(code, /_entry\["segments"\] = _nominfo\[_i\]\["segments"\]/);
  // Text cell coloring: gated by _do_text (off by default), cells map via vmap,
  // tail -> gray.
  assert.match(buildDumpCode('x', { colorizeText: true }), /_do_text = True/);
  assert.match(code, /_do_text = False/);
  assert.match(code, /_vm\.get\(str\(_v\), "#888888"\)/);
  // The whole filter-hint example is built in Python (real dtypes). It ships as
  // `filterHint` and the webview just wraps it.
  assert.match(code, /"filterHint": %s/);
  // Value clause by dtype priority: numeric > 0, datetime, timedelta, else
  // last column != its first value; backticking via str.isidentifier/keyword.
  assert.match(code, /"%s > 0" % _qcol/);
  assert.match(code, /"%s > '1986-06-30'" % _qcol/);
  assert.match(code, /"%s < '1 days 01:23:45'" % _qcol/);
  assert.match(code, /"%s != %s" % \(_qcol\(_cols\[_vi\]\), _lit\(_fv\)\)/);
  assert.match(code, /_kw\.iskeyword/);
  // The .notna() and value clauses are ordered by column position.
  assert.match(code, /"\(%s & %s\.notna\(\)\)" % \(_vc, _qcol\(_cols\[_ni\]\)\)/);
  assert.match(code, /"\(%s\.notna\(\) & %s\)" % \(_qcol\(_cols\[_ni\]\), _vc\)/);
  // Index clause: `index` for a single index; a MultiIndex level uses its name,
  // or `ilevel_0` when unnamed; datetime/timedelta use a quoted str().
  assert.match(code, /_idx = "index != %s" % _rhs/);
  assert.match(code, /isinstance\(_ii, pd\.MultiIndex\)/);
  assert.match(code, /"ilevel_0"/);
  assert.match(code, /return repr\(str\(_v\)\) if _t else _lit\(_v\)/);
  // The index clause is ORed in front of the column clause.
  assert.match(code, /filter_hint = " \| "\.join\(\[_idx, _inner\]\) if _idx else _inner/);
  // Sorting: empty by default; a stable multi-key sort when keys are given.
  assert.match(code, /_sort = \[\]/);
  const sorted = buildDumpCode('df', { sort: [{ column: 2, descending: true }, { column: 0, descending: false }] });
  assert.match(sorted, /_sort = \[\(2, True\), \(0, False\)\]/);
  assert.match(sorted, /reset_index\(drop=False, allow_duplicates=True\)/);
  assert.match(sorted, /sort_values\(by=_by, ascending=_asc/);
  assert.match(sorted, /kind="stable", na_position="last"/);
  // The index sorts as key -1 (its level(s) materialized at the front).
  assert.match(buildDumpCode('df', { sort: [{ column: -1, descending: true }] }), /_sort = \[\(-1, True\)\]/);
  assert.match(sorted, /if _c < 0:/);
  assert.match(sorted, /_c \+ _nlev/);
  // Filtering: empty by default; a query() applied (before sort) when given,
  // with the error captured rather than thrown.
  assert.match(code, /_filter = ""/);
  const filtered = buildDumpCode('df', { filter: 'founded > 1000 & last_census.notna()' });
  assert.match(filtered, /_filter = "founded > 1000 & last_census\.notna\(\)"/);
  assert.match(filtered, /obj\.query\(_filter, engine="python"\)/);
  assert.match(filtered, /"filterError": %s/);
  // The filter runs before the sort.
  assert.ok(filtered.indexOf('obj.query(_filter') < filtered.indexOf('reset_index'));
  // Regression guards: no old single-name default, no dropped showIndex field.
  assert.doesNotMatch(code, /else "index"/);
  assert.doesNotMatch(code, /showIndex/);
});

test('parquetReadExpression reads via pd.read_parquet with an escaped path', () => {
  assert.equal(parquetReadExpression('/tmp/a.parquet'), 'pd.read_parquet("/tmp/a.parquet")');
});

test('featherReadExpression reads via pd.read_feather with an escaped path', () => {
  assert.equal(featherReadExpression('/tmp/a.feather'), 'pd.read_feather("/tmp/a.feather")');
});

test('jsonLinesReadExpression reads via pd.read_json with lines=True', () => {
  assert.equal(jsonLinesReadExpression('/tmp/a.jsonl'), 'pd.read_json("/tmp/a.jsonl", lines=True)');
});

test('buildDumpCode reads CSV files via the delimiter-sniffing helper', () => {
  const code = buildDumpCode(csvReadExpression('/tmp/x.csv'));
  assert.match(code, /def _read_csv/);
  assert.match(code, /Sniffer\(\)\.sniff/);
  assert.match(code, /obj = _read_csv\("\/tmp\/x\.csv"\)/);
});
