// Builds the filter input's placeholder from the actual columns, so the example
// uses real names and type-appropriate values. Pure (no DOM) for testability.
import { ColumnType } from '../shared/protocol';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Python keywords must be backticked in query() even though they're valid
// identifiers, or the parser reads them as keywords rather than column names.
const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/** Quotes a column name for a query expression (backticks if not a plain name). */
function quote(name: string): string {
  return IDENTIFIER.test(name) && !PY_KEYWORDS.has(name) ? name : '`' + name + '`';
}

/** A single-quoted Python string literal of a sample value. */
function pyStr(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * A `DataFrame.query` example using this table's columns. Picks a "value" clause
 * by type — numeric `> 0`, else datetime `> '1986-06-30'`, else timedelta
 * `< '1 days 01:23:45'`, else the last column `!= <its first value>` — combines
 * it with a `.notna()` on another column, and ORs in an `index` clause.
 * `columns`/`columnTypes`/`sample` are index-first; the index is skipped for the
 * column clauses.
 */
export function filterPlaceholder(
  columns: string[],
  columnTypes: ColumnType[] | null,
  sample: string[][]
): string {
  const data = columns.slice(1);
  if (data.length === 0) {
    return 'Filter rows with a pandas query expression';
  }
  const kinds = columnTypes ? columnTypes.slice(1) : [];
  const firstOf = (kind: string) => kinds.findIndex((t) => t.kind === kind);

  let vIdx = firstOf('numeric');
  let valueClause: string;
  if (vIdx >= 0) {
    valueClause = `${quote(data[vIdx])} > 0`;
  } else {
    vIdx = firstOf('datetime');
    if (vIdx >= 0) {
      valueClause = `${quote(data[vIdx])} > '1986-06-30'`;
    } else {
      vIdx = firstOf('timedelta');
      if (vIdx >= 0) {
        valueClause = `${quote(data[vIdx])} < '1 days 01:23:45'`;
      } else {
        vIdx = data.length - 1;
        // sample rows are index-first, so data column vIdx is at row[vIdx + 1].
        valueClause = `${quote(data[vIdx])} != ${pyStr(sample[0]?.[vIdx + 1] ?? '')}`;
      }
    }
  }

  // A .notna() on a different column, grouped with the value clause.
  const naIdx = data.findIndex((_, i) => i !== vIdx);
  const inner = naIdx >= 0 ? `(${quote(data[naIdx])}.notna() & ${valueClause})` : valueClause;
  return `Filter rows, e.g.  index > 1 | ${inner}`;
}
