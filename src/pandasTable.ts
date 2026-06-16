/**
 * The single pandas-backed data path: Python code that serializes any
 * DataFrame-like object as one JSON payload on stdout, plus the TypeScript
 * side that turns the payload into table columns/rows. Used both by the
 * Jupyter kernel path (variables) and the subprocess path (CSV files).
 */
import { ColumnStat, ColumnType, SortKey } from './shared/protocol';

export const MAX_ROWS = 100_000;

/** Number of equal-width bins in the per-column numeric histogram. */
export const HIST_BINS = 16;

/** Colormap applied to numeric values for the heatmap (any matplotlib name). */
export const HEATMAP_CMAP = 'viridis';

export interface DumpPayload {
  total: number;
  /** The DataFrame index name, or "" when the index is unnamed. */
  indexName: string;
  table: { columns: string[]; index: unknown[]; data: unknown[][] };
  /**
   * Per-cell background colors for the heatmap, aligned to `table.data`
   * (rows × data columns): a "#rrggbb" string for colored cells, null for
   * uncolored cells (non-numeric/non-datetime, NaN/NaT, or a disabled type).
   * null overall when nothing is colored (no colorable columns, all types
   * disabled, or matplotlib unavailable in the environment).
   */
  colors: (string | null)[][] | null;
  /**
   * Per-column dtype info aligned to the final columns (index first, then data
   * columns), or null if it couldn't be computed.
   */
  columnTypes: ColumnType[] | null;
  /**
   * Per-column summary stats aligned to the final columns (index first), or
   * null if they couldn't be computed. Counted over the full (filtered) frame,
   * not the truncated `head`, so the counts are exact.
   */
  stats: ColumnStat[] | null;
  /** pandas error message from a failed filter query, or null. */
  filterError: string | null;
}

export interface DumpOptions {
  /** matplotlib colormap name. */
  colormap?: string;
  /** Symmetric range around 0 (vmax = max(|vmin|, |vmax|), vmin = -vmax). */
  center?: boolean;
  /** Range computed per column instead of once per type group. */
  columnwise?: boolean;
  /** Color numeric columns (default true). */
  colorizeNumeric?: boolean;
  /** Color datetime/timedelta columns by their timestamp (default true). */
  colorizeDatetime?: boolean;
  /** Color ordered categorical columns by their rank (default true). */
  colorizeCategorical?: boolean;
  /** Multi-column sort keys (primary first); columns are data-column positions, -1 = index. */
  sort?: SortKey[];
  /** A pandas `DataFrame.query` expression; empty = no filter. */
  filter?: string;
}

/**
 * Builds Python code that evaluates `objExpr`, normalizes it to a DataFrame
 * and prints the payload. Everything lives inside one temporary function so a
 * kernel's user namespace only ever sees (and loses) one name.
 *
 * Heatmap colors are computed per type group: numeric columns share one
 * vmin/vmax, datetime/timedelta columns share a separate one (so timestamps
 * never distort the numeric range). `columnwise` instead ranges each column on
 * its own; `center` makes a range symmetric around 0.
 */
export function buildDumpCode(objExpr: string, options: DumpOptions = {}): string {
  const cmap = options.colormap ?? HEATMAP_CMAP;
  const center = options.center ?? false;
  const columnwise = options.columnwise ?? false;
  const colorizeNumeric = options.colorizeNumeric ?? true;
  const colorizeDatetime = options.colorizeDatetime ?? true;
  const colorizeCategorical = options.colorizeCategorical ?? true;
  // Sort keys become a Python list of (position, descending) tuples (-1 = the
  // index). Filter to safe integers so the literal can't be anything but
  // numbers/bools.
  const sortKeys = (options.sort ?? []).filter((k) => Number.isInteger(k.column) && k.column >= -1);
  const sortLiteral =
    '[' + sortKeys.map((k) => `(${k.column}, ${k.descending ? 'True' : 'False'})`).join(', ') + ']';
  // A JSON string literal is a valid Python string literal (handles escaping).
  const filterLiteral = JSON.stringify(options.filter ?? '');
  return [
    'def _VSCODE_dataviewer_dump():',
    '    import csv',
    '    import json',
    '    import pandas as pd',
    '    def _read_csv(path):',
    // Sniff the delimiter on a *decompressed* sample (get_handle infers
    // compression), constrained to common delimiters. Fall back to pandas\'
    // own sniffer (sep=None) if anything goes wrong — it also decompresses.
    // read_csv then infers compression from the extension by default.
    '        _sep = None',
    '        try:',
    '            from pandas.io.common import get_handle',
    '            with get_handle(path, "r", compression="infer", errors="replace") as _h:',
    '                _sample = _h.handle.read(65536)',
    '            _sep = csv.Sniffer().sniff(_sample, delimiters=",;\\t|").delimiter',
    '        except Exception:',
    '            _sep = None',
    '        if _sep is None:',
    '            return pd.read_csv(path, sep=None, engine="python")',
    '        return pd.read_csv(path, sep=_sep)',
    `    obj = ${objExpr}`,
    '    if isinstance(obj, pd.Series):',
    '        obj = obj.to_frame()',
    '    elif not isinstance(obj, pd.DataFrame):',
    '        obj = pd.DataFrame(obj)',
    // Filter via DataFrame.query (bare column names, &/|, .isna(), `index`, …).
    // engine="python" so string/datetime/categorical comparisons work. On a bad
    // expression we report the error and leave the data unfiltered.
    `    _filter = ${filterLiteral}`,
    '    _filter_error = None',
    '    if _filter:',
    '        try:',
    '            obj = obj.query(_filter, engine="python")',
    '        except Exception as _e:',
    '            _filter_error = str(_e)',
    // Stable multi-key sort. Each key is a data-column position, or -1 for the
    // index. reset_index materializes the index level(s) as leading columns so
    // index and columns sort uniformly; we then reorder the original frame by
    // the resulting row positions (preserving its index, names and dtypes).
    // Left unsorted if the keys don't apply (e.g. uncomparable mixed-type column).
    `    _sort = ${sortLiteral}`,
    '    if _sort:',
    '        try:',
    '            _nlev = obj.index.nlevels',
    '            _si = obj.reset_index(drop=False, allow_duplicates=True)',
    '            _si.columns = range(_si.shape[1])',
    '            _by = []',
    '            _asc = []',
    '            for _c, _d in _sort:',
    '                if _c < 0:',
    '                    _by.extend(range(_nlev))',
    '                    _asc.extend([not _d] * _nlev)',
    '                else:',
    '                    _by.append(_c + _nlev)',
    '                    _asc.append(not _d)',
    '            _si = _si.sort_values(by=_by, ascending=_asc, kind="stable", na_position="last")',
    '            obj = obj.iloc[_si.index.to_numpy()]',
    '        except Exception:',
    '            pass',
    '    total = len(obj)',
    // Per-column summary stats over the *full* filtered frame (not the truncated
    // head, so counts are exact). Aligned index-first like column_types. The
    // missing (NaN/NaT/None) count is meaningful for every dtype; numeric data
    // columns also get an equal-width histogram (np.histogram returns counts +
    // edges in one call) over their non-null values.
    '    stats = None',
    '    try:',
    '        import numpy as _np',
    '        def _missing(_x):',
    '            try:',
    '                return int(pd.isna(_x).sum())',
    '            except Exception:',
    '                return 0',
    // "Nice" bin edges (Heckbert): pick a step of the form {1,2,5}×10^k near
    // range/HIST_BINS, then snap the low/high edges down/up to multiples of it,
    // so every edge is a readable round number on a shared grid. Edges are
    // rounded to the step's precision to shed floating-point noise, then shipped
    // verbatim (the webview shows them as-is).
    '        def _nice(_x, _round):',
    '            _e = _np.floor(_np.log10(_x))',
    '            _f = _x / 10.0 ** _e',
    '            if _round:',
    '                _nf = 1 if _f < 1.5 else 2 if _f < 3 else 5 if _f < 7 else 10',
    '            else:',
    '                _nf = 1 if _f <= 1 else 2 if _f <= 2 else 5 if _f <= 5 else 10',
    '            return _nf * 10.0 ** _e',
    // Round to 3 significant figures for the min/median/max labels (the actual
    // data values, which don\'t sit on the bin grid).
    '        def _sig(_x):',
    '            if not _np.isfinite(_x) or _x == 0:',
    '                return 0.0',
    '            return round(float(_x), 2 - int(_np.floor(_np.log10(abs(_x)))))',
    '        def _hist(_c):',
    '            try:',
    '                if not pd.api.types.is_numeric_dtype(_c) or pd.api.types.is_bool_dtype(_c):',
    '                    return None',
    '                _v = _c.to_numpy(dtype="float64")',
    '                _v = _v[_np.isfinite(_v)]',
    '                if not _v.size:',
    '                    return None',
    '                _lo, _hi = float(_v.min()), float(_v.max())',
    '                _md = float(_np.median(_v))',
    '                if _hi <= _lo:',
    '                    return {"counts": [int(_v.size)], "edges": [_lo, _hi], "min": _sig(_lo), "median": _sig(_lo), "max": _sig(_lo)}',
    `                _step = _nice((_hi - _lo) / ${HIST_BINS}, True)`,
    '                _nmin = _np.floor(_lo / _step) * _step',
    '                _nmax = _np.ceil(_hi / _step) * _step',
    '                _edges = _np.arange(_nmin, _nmax + 0.5 * _step, _step)',
    '                _counts, _edges = _np.histogram(_v, bins=_edges)',
    '                _dec = int(max(0, -_np.floor(_np.log10(_step) + 1e-9)))',
    '                return {"counts": [int(_n) for _n in _counts], "edges": [round(float(_e), _dec) for _e in _edges], "min": _sig(_lo), "median": _sig(_md), "max": _sig(_hi)}',
    '            except Exception:',
    '                return None',
    // Ordered-categorical columns get a bar per category in *category order*
    // (so the rank-based colors read as a gradient), with each bar tinted by the
    // heatmap colormap at its rank — the bars map 1:1 to the categories.
    '        def _bars(_c):',
    '            try:',
    '                if not isinstance(_c.dtype, pd.CategoricalDtype) or not _c.dtype.ordered:',
    '                    return None',
    '                _cats = list(_c.dtype.categories)',
    '                _vc = _c.value_counts()',
    '                _counts = [int(_vc.get(_k, 0)) for _k in _cats]',
    '                _labels = [str(_k) for _k in _cats]',
    '                _colors = None',
    '                try:',
    '                    import matplotlib as _mpl',
    `                    _cm = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    '                    _k = len(_cats)',
    '                    _colors = []',
    '                    for _j in range(_k):',
    '                        _t = _j / (_k - 1) if _k > 1 else 0.0',
    '                        _rgb = [int(round(_x * 255)) for _x in _cm(_t)[:3]]',
    '                        _colors.append("#%02x%02x%02x" % (_rgb[0], _rgb[1], _rgb[2]))',
    '                except Exception:',
    '                    _colors = None',
    '                return {"labels": _labels, "counts": _counts, "colors": _colors}',
    '            except Exception:',
    '                return None',
    // Unordered discrete columns (object/string, unordered categorical, bool)
    // get a stacked-bar distribution: the top values by count plus an "(other)"
    // bucket, tinted with a *qualitative* palette (tab10) so no order is implied.
    // `unique` carries the full distinct count for the caption.
    '        def _segments(_c):',
    '            try:',
    '                if pd.api.types.is_datetime64_any_dtype(_c) or pd.api.types.is_timedelta64_dtype(_c):',
    '                    return None',
    '                if pd.api.types.is_numeric_dtype(_c) and not pd.api.types.is_bool_dtype(_c):',
    '                    return None',
    '                if isinstance(_c.dtype, pd.CategoricalDtype) and _c.dtype.ordered:',
    '                    return None',
    '                _vc = _c.value_counts(dropna=True)',
    '                if _vc.size == 0:',
    '                    return None',
    '                _TOP = 9',
    '                _top = _vc.iloc[:_TOP]',
    '                _labels = [str(_k) for _k in _top.index]',
    '                _counts = [int(_n) for _n in _top.values]',
    '                _other = int(_vc.iloc[_TOP:].sum())',
    '                if _other > 0:',
    '                    _labels.append("(other)")',
    '                    _counts.append(_other)',
    '                _colors = None',
    '                try:',
    '                    import matplotlib as _mpl',
    '                    _qual = _mpl.colormaps["tab10"]',
    // tab10 minus C7 (#7f7f7f gray), which clashes with the "(other)" gray.
    '                    _idx = [0, 1, 2, 3, 4, 5, 6, 8, 9]',
    '                    _colors = []',
    '                    for _j in range(len(_top)):',
    '                        _rgb = [int(round(_x * 255)) for _x in _qual(_idx[_j % len(_idx)])[:3]]',
    '                        _colors.append("#%02x%02x%02x" % (_rgb[0], _rgb[1], _rgb[2]))',
    '                    if _other > 0:',
    '                        _colors.append("#888888")',
    '                except Exception:',
    '                    _colors = None',
    '                return {"labels": _labels, "counts": _counts, "colors": _colors, "unique": int(_vc.size)}',
    '            except Exception:',
    '                return None',
    '        stats = [{"missing": _missing(obj.index)}]',
    '        for _i in range(obj.shape[1]):',
    '            _col = obj.iloc[:, _i]',
    '            _entry = {"missing": _missing(_col)}',
    '            _h = _hist(_col)',
    '            if _h is not None:',
    '                _entry["histogram"] = _h',
    '            else:',
    '                _b = _bars(_col)',
    '                if _b is not None:',
    '                    _entry["bars"] = _b',
    '                else:',
    '                    _s = _segments(_col)',
    '                    if _s is not None:',
    '                        _entry["segments"] = _s',
    '            stats.append(_entry)',
    '    except Exception:',
    '        stats = None',
    `    head = obj.head(${MAX_ROWS}).copy()`,
    // index.names works for both a regular Index (one element) and a
    // MultiIndex (whose .name is always None); join the level names so a
    // MultiIndex still gets a header. Blank when no level is named.
    '    index_names = [str(n) if n is not None else "" for n in head.index.names]',
    '    index_name = ", ".join(index_names) if any(index_names) else ""',
    // Render datetimes/timedeltas like str()/print ("2022-05-15 08:30:00")
    // instead of the ISO format to_json emits; NaT stays null (blank cell).
    '    def _vscode_fmt(col):',
    '        if pd.api.types.is_datetime64_any_dtype(col) or pd.api.types.is_timedelta64_dtype(col):',
    '            return col.map(lambda x: None if pd.isna(x) else str(x))',
    '        return col',
    // Keep the original-dtype frame for color computation; `head` becomes the
    // stringified display version.
    '    _raw = head',
    '    head = head.apply(_vscode_fmt)',
    '    head.columns = [str(c) for c in head.columns]',
    '    if isinstance(head.index, pd.MultiIndex):',
    '        head.index = [str(i) for i in head.index]',
    '    elif pd.api.types.is_datetime64_any_dtype(head.index) or pd.api.types.is_timedelta64_dtype(head.index):',
    '        head.index = [None if pd.isna(i) else str(i) for i in head.index]',
    '    table = head.to_json(orient="split", date_format="iso", default_handler=str)',
    // Heatmap colors, computed from the original-dtype frame. Numeric, datetime
    // and timedelta columns form three separate range groups (each in its own
    // unit, so they never distort each other); within a group the range is
    // shared, or per-column when columnwise. Ordered categoricals are colored by
    // rank over their full 0..n-1 code range (always per-column). `center` makes
    // a range symmetric but is skipped for datetimes (arbitrary epoch origin) and
    // categoricals (0 is just the first category). Wrapped in try/except so a
    // kernel without matplotlib still views fine.
    '    colors = None',
    '    try:',
    '        import numpy as _np',
    '        import matplotlib as _mpl',
    `        _cmap = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    `        _center = ${center ? 'True' : 'False'}`,
    `        _columnwise = ${columnwise ? 'True' : 'False'}`,
    `        _do_num = ${colorizeNumeric ? 'True' : 'False'}`,
    `        _do_dt = ${colorizeDatetime ? 'True' : 'False'}`,
    `        _do_cat = ${colorizeCategorical ? 'True' : 'False'}`,
    '        _ncols, _nrows = _raw.shape[1], _raw.shape[0]',
    '        _vals = [None] * _ncols',
    '        _grp = [None] * _ncols',
    '        _fixed = [None] * _ncols',
    '        for _i in range(_ncols):',
    '            _c = _raw.iloc[:, _i]',
    '            if _do_num and pd.api.types.is_numeric_dtype(_c) and not pd.api.types.is_bool_dtype(_c):',
    '                _vals[_i] = _c.to_numpy(dtype="float64")',
    '                _grp[_i] = "num"',
    '            elif _do_dt and (pd.api.types.is_datetime64_any_dtype(_c) or pd.api.types.is_timedelta64_dtype(_c)):',
    '                _a = _c.to_numpy()',
    '                _f = _a.astype("int64").astype("float64")',
    '                _f[_np.isnat(_a)] = _np.nan',
    '                _vals[_i] = _f',
    '                _grp[_i] = "datetime" if pd.api.types.is_datetime64_any_dtype(_c) else "timedelta"',
    '            elif _do_cat and isinstance(_c.dtype, pd.CategoricalDtype) and _c.dtype.ordered:',
    '                _codes = _c.cat.codes.to_numpy().astype("float64")',
    '                _codes[_codes < 0] = _np.nan',
    '                _vals[_i] = _codes',
    '                _grp[_i] = "categorical"',
    '                _fixed[_i] = (0.0, float(len(_c.dtype.categories) - 1))',
    '        def _grange(_g):',
    '            _members = [_vals[_i] for _i in range(_ncols) if _grp[_i] == _g]',
    '            if not _members:',
    '                return None',
    '            _s = _np.concatenate([_m[_np.isfinite(_m)] for _m in _members])',
    '            return (float(_s.min()), float(_s.max())) if _s.size else None',
    '        _ranges = {_g: _grange(_g) for _g in ("num", "datetime", "timedelta")}',
    '        if _nrows and any(_g is not None for _g in _grp):',
    '            _cols = [[None] * _nrows for _ in range(_ncols)]',
    '            for _i in range(_ncols):',
    '                if _grp[_i] is None:',
    '                    continue',
    '                _arr = _vals[_i]',
    '                _mask = _np.isfinite(_arr)',
    '                if not _mask.any():',
    '                    continue',
    '                if _fixed[_i] is not None:',
    '                    _lo, _hi = _fixed[_i]',
    '                elif _columnwise:',
    '                    _cf = _arr[_mask]',
    '                    _lo, _hi = float(_cf.min()), float(_cf.max())',
    '                else:',
    '                    _r = _ranges[_grp[_i]]',
    '                    if _r is None:',
    '                        continue',
    '                    _lo, _hi = _r',
    '                if _center and _grp[_i] not in ("datetime", "categorical"):',
    '                    _hi = max(abs(_lo), abs(_hi))',
    '                    _lo = -_hi',
    '                _denom = (_hi - _lo) or 1.0',
    '                _norm = _np.clip((_arr - _lo) / _denom, 0.0, 1.0)',
    '                _rgb = (_cmap(_norm)[:, :3] * 255).round().astype("int64")',
    '                _packed = (_rgb[:, 0] << 16) | (_rgb[:, 1] << 8) | _rgb[:, 2]',
    '                _hex = ["#%06x" % int(p) for p in _packed]',
    '                _cols[_i] = [h if m else None for h, m in zip(_hex, _mask)]',
    '            if any(any(c is not None for c in _col) for _col in _cols):',
    '                colors = [list(_row) for _row in zip(*_cols)]',
    '    except Exception:',
    '        colors = None',
    // Per-column dtype + coarse kind (for a type glyph + tooltip), aligned to
    // the final columns: index first, then each data column.
    '    column_types = None',
    '    try:',
    '        def _kind(_x):',
    '            if pd.api.types.is_bool_dtype(_x):',
    '                return "bool"',
    '            if pd.api.types.is_datetime64_any_dtype(_x):',
    '                return "datetime"',
    '            if pd.api.types.is_timedelta64_dtype(_x):',
    '                return "timedelta"',
    '            if isinstance(getattr(_x, "dtype", _x), pd.CategoricalDtype):',
    '                return "categorical"',
    '            if pd.api.types.is_numeric_dtype(_x):',
    '                return "numeric"',
    '            if pd.api.types.is_string_dtype(_x):',
    '                return "text"',
    '            return "other"',
    '        if isinstance(_raw.index, pd.MultiIndex):',
    '            column_types = [{"dtype": "object", "kind": "other"}]',
    '        else:',
    '            column_types = [{"dtype": str(_raw.index.dtype), "kind": _kind(_raw.index)}]',
    '        for _i in range(_raw.shape[1]):',
    '            _col = _raw.iloc[:, _i]',
    '            column_types.append({"dtype": str(_col.dtype), "kind": _kind(_col)})',
    '    except Exception:',
    '        column_types = None',
    '    print(\'{"total": %d, "indexName": %s, "table": %s, "colors": %s, "columnTypes": %s, "stats": %s, "filterError": %s}\'',
    '          % (total, json.dumps(index_name), table, json.dumps(colors), json.dumps(column_types), json.dumps(stats), json.dumps(_filter_error)))',
    '',
    '_VSCODE_dataviewer_dump()',
    'del _VSCODE_dataviewer_dump',
  ].join('\n');
}

/** Expression reading a CSV/TSV file with delimiter sniffing (",;\t|"). */
export function csvReadExpression(fsPath: string): string {
  // A JSON string literal is also a valid Python string literal.
  return `_read_csv(${JSON.stringify(fsPath)})`;
}

/** Expression reading a Parquet file (needs pyarrow/fastparquet in the env). */
export function parquetReadExpression(fsPath: string): string {
  return `pd.read_parquet(${JSON.stringify(fsPath)})`;
}

/** Expression reading a Feather/Arrow IPC file (needs pyarrow in the env). */
export function featherReadExpression(fsPath: string): string {
  return `pd.read_feather(${JSON.stringify(fsPath)})`;
}

/** Expression reading a JSON Lines file (one record per line); no extra dep. */
export function jsonLinesReadExpression(fsPath: string): string {
  return `pd.read_json(${JSON.stringify(fsPath)}, lines=True)`;
}

/**
 * Extracts the payload from captured stdout. Tolerates stray prints before
 * ours by falling back to the last non-empty line.
 */
export function parsePayload(stdout: string): DumpPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Python returned no data.');
  }
  try {
    return JSON.parse(trimmed) as DumpPayload;
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
    return JSON.parse(lines[lines.length - 1]) as DumpPayload;
  }
}

export interface TableContent {
  /**
   * Column headers. The first entry is the DataFrame index ("" when the index
   * is unnamed); the rest are the data columns. Each row in `rows` follows the
   * same layout, so the index always rides along as column 0.
   */
  columns: string[];
  rows: string[][];
  /**
   * Per-cell heatmap background colors aligned to `rows` (the index column,
   * like the header, gets a leading null since it is never colored). null when
   * no heatmap applies.
   */
  colors: (string | null)[][] | null;
  /** Per-column dtype info aligned to `columns` (index first), or null. */
  columnTypes: ColumnType[] | null;
  /** Per-column summary stats aligned to `columns` (index first), or null. */
  stats: ColumnStat[] | null;
  /** Total rows in the full (filtered) data, before truncation to MAX_ROWS. */
  total: number;
  /** pandas error message from a failed filter query, or null. */
  filterError: string | null;
  /** Status-bar notice when the data was truncated to MAX_ROWS. */
  note?: string;
}

export function toTable(payload: DumpPayload): TableContent {
  const { table } = payload;
  const format = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  const columns = [payload.indexName, ...table.columns];
  const rows = table.data.map((row, i) => [format(table.index[i]), ...row.map(format)]);
  // Prepend a null for the index column so colors line up with rows/columns.
  const colors = payload.colors ? payload.colors.map((row) => [null, ...row]) : null;
  const note =
    payload.total > table.data.length
      ? `showing first ${table.data.length.toLocaleString()} of ${payload.total.toLocaleString()} rows`
      : undefined;
  // columnTypes/stats already include the index at [0], so they line up with columns.
  return {
    columns,
    rows,
    colors,
    columnTypes: payload.columnTypes,
    stats: payload.stats,
    total: payload.total,
    filterError: payload.filterError,
    note,
  };
}
