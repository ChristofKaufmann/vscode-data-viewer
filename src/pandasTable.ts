/**
 * The single pandas-backed data path: Python code that serializes any
 * DataFrame-like object as one JSON payload on stdout, plus the TypeScript
 * side that turns the payload into table columns/rows. Used both by the
 * Jupyter kernel path (variables) and the subprocess path (CSV files).
 */

export const MAX_ROWS = 100_000;

/** Colormap applied to numeric values for the heatmap (any matplotlib name). */
export const HEATMAP_CMAP = 'viridis';

export interface DumpPayload {
  total: number;
  /** The DataFrame index name, or "" when the index is unnamed. */
  indexName: string;
  table: { columns: string[]; index: unknown[]; data: unknown[][] };
  /**
   * Per-cell background colors for the heatmap, aligned to `table.data`
   * (rows × data columns): a "#rrggbb" string for numeric cells, null for
   * non-numeric/NaN cells. null overall when no heatmap applies (no numeric
   * columns, or matplotlib unavailable in the environment).
   */
  colors: (string | null)[][] | null;
}

/**
 * Builds Python code that evaluates `objExpr`, normalizes it to a DataFrame
 * and prints the payload. Everything lives inside one temporary function so
 * a kernel's user namespace only ever sees (and loses) one name. `cmap` is the
 * matplotlib colormap used for the heatmap colors; `center` makes the value
 * range symmetric around 0 (vmax = max(|vmin|, |vmax|), vmin = -vmax);
 * `columnwise` computes the range per column instead of once over all numerics.
 */
export function buildDumpCode(
  objExpr: string,
  cmap: string = HEATMAP_CMAP,
  center: boolean = false,
  columnwise: boolean = false
): string {
  return [
    'def _VSCODE_dataviewer_dump():',
    '    import csv',
    '    import json',
    '    import pandas as pd',
    '    def _read_csv(path):',
    '        with open(path, "r", newline="", errors="replace") as f:',
    '            sample = f.read(65536)',
    '        try:',
    '            sep = csv.Sniffer().sniff(sample, delimiters=",;\\t|").delimiter',
    '        except Exception:',
    '            sep = ","',
    '        return pd.read_csv(path, sep=sep)',
    `    obj = ${objExpr}`,
    '    if isinstance(obj, pd.Series):',
    '        obj = obj.to_frame()',
    '    elif not isinstance(obj, pd.DataFrame):',
    '        obj = pd.DataFrame(obj)',
    '    total = len(obj)',
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
    '    head = head.apply(_vscode_fmt)',
    '    head.columns = [str(c) for c in head.columns]',
    '    if isinstance(head.index, pd.MultiIndex):',
    '        head.index = [str(i) for i in head.index]',
    '    elif pd.api.types.is_datetime64_any_dtype(head.index) or pd.api.types.is_timedelta64_dtype(head.index):',
    '        head.index = [None if pd.isna(i) else str(i) for i in head.index]',
    '    table = head.to_json(orient="split", date_format="iso", default_handler=str)',
    // Heatmap colors: map every numeric cell through a matplotlib colormap.
    // The value range is either shared across all numeric columns or computed
    // per column (columnwise); `center` makes it symmetric around 0. Non-numeric
    // and NaN cells stay null. Wrapped in try/except so a kernel without
    // matplotlib still views fine (colors just become null).
    '    colors = None',
    '    try:',
    '        import numpy as _np',
    '        import matplotlib as _mpl',
    `        _cmap = _mpl.colormaps[${JSON.stringify(cmap)}]`,
    `        _center = ${center ? 'True' : 'False'}`,
    `        _columnwise = ${columnwise ? 'True' : 'False'}`,
    '        _ncols, _nrows = head.shape[1], head.shape[0]',
    '        _numeric = [i for i in range(_ncols)',
    '                    if pd.api.types.is_numeric_dtype(head.iloc[:, i])',
    '                    and not pd.api.types.is_bool_dtype(head.iloc[:, i])]',
    '        if _numeric and _nrows:',
    '            _stacked = _np.concatenate([head.iloc[:, i].to_numpy(dtype="float64") for i in _numeric])',
    '            _gfinite = _stacked[_np.isfinite(_stacked)]',
    '            if _gfinite.size:',
    '                _glo, _ghi = float(_gfinite.min()), float(_gfinite.max())',
    '                _cols = [[None] * _nrows for _ in range(_ncols)]',
    '                for i in _numeric:',
    '                    _arr = head.iloc[:, i].to_numpy(dtype="float64")',
    '                    _mask = _np.isfinite(_arr)',
    '                    if _columnwise:',
    '                        _cf = _arr[_mask]',
    '                        if not _cf.size:',
    '                            continue',
    '                        _lo, _hi = float(_cf.min()), float(_cf.max())',
    '                    else:',
    '                        _lo, _hi = _glo, _ghi',
    '                    if _center:',
    '                        _hi = max(abs(_lo), abs(_hi))',
    '                        _lo = -_hi',
    '                    _denom = (_hi - _lo) or 1.0',
    '                    _norm = _np.clip((_arr - _lo) / _denom, 0.0, 1.0)',
    '                    _rgb = (_cmap(_norm)[:, :3] * 255).round().astype("int64")',
    '                    _packed = (_rgb[:, 0] << 16) | (_rgb[:, 1] << 8) | _rgb[:, 2]',
    '                    _hex = ["#%06x" % int(p) for p in _packed]',
    '                    _cols[i] = [h if m else None for h, m in zip(_hex, _mask)]',
    '                colors = [list(_row) for _row in zip(*_cols)]',
    '    except Exception:',
    '        colors = None',
    '    print(\'{"total": %d, "indexName": %s, "table": %s, "colors": %s}\'',
    '          % (total, json.dumps(index_name), table, json.dumps(colors)))',
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
  return { columns, rows, colors, note };
}
