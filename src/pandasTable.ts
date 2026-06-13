/**
 * The single pandas-backed data path: Python code that serializes any
 * DataFrame-like object as one JSON payload on stdout, plus the TypeScript
 * side that turns the payload into table columns/rows. Used both by the
 * Jupyter kernel path (variables) and the subprocess path (CSV files).
 */

export const MAX_ROWS = 100_000;

export interface DumpPayload {
  total: number;
  /** The DataFrame index name, or "" when the index is unnamed. */
  indexName: string;
  table: { columns: string[]; index: unknown[]; data: unknown[][] };
}

/**
 * Builds Python code that evaluates `objExpr`, normalizes it to a DataFrame
 * and prints the payload. Everything lives inside one temporary function so
 * a kernel's user namespace only ever sees (and loses) one name.
 */
export function buildDumpCode(objExpr: string): string {
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
    '    head.columns = [str(c) for c in head.columns]',
    '    if isinstance(head.index, pd.MultiIndex):',
    '        head.index = [str(i) for i in head.index]',
    '    table = head.to_json(orient="split", date_format="iso", default_handler=str)',
    '    print(\'{"total": %d, "indexName": %s, "table": %s}\'',
    '          % (total, json.dumps(index_name), table))',
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
  const note =
    payload.total > table.data.length
      ? `showing first ${table.data.length.toLocaleString()} of ${payload.total.toLocaleString()} rows`
      : undefined;
  return { columns, rows, note };
}
