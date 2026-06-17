// Messages exchanged between the extension host and the webview.
// Rows are transferred lazily in fixed-size chunks so large files
// never have to cross the message channel all at once.

export const CHUNK_SIZE = 500;

/** One key of a (possibly multi-column) sort, primary first. */
export interface SortKey {
  /** 0-based position among the data columns, or -1 for the index column. */
  column: number;
  descending: boolean;
}

/** A column's pandas dtype string and a coarse kind used to pick a glyph. */
export interface ColumnType {
  /** Full dtype string for the tooltip, e.g. "float64", "datetime64[ns]". */
  dtype: string;
  /** Coarse category: numeric | bool | text | datetime | timedelta | categorical | other. */
  kind: string;
}

/** Summary statistics for one column, computed over the full (filtered) data. */
export interface ColumnStat {
  /** Count of missing (NaN/NaT/None) values across all rows, before truncation. */
  missing: number;
  /**
   * Histogram for numeric columns (over non-null values), or absent for
   * non-numeric columns. Bins use a "nice" rounded grid, so `edges` (length
   * `counts.length + 1`) are readable round numbers shown verbatim. `min`,
   * `median` and `max` are the actual data values (rounded for labels), which
   * lie within the grid range.
   */
  histogram?: { counts: number[]; edges: number[]; min: number; median: number; max: number };
  /**
   * Bar chart for ordered-categorical columns: one entry per category, in
   * category (rank) order. `colors` are the colormap sampled at each
   * rank (a "#rrggbb" per bar), or null if matplotlib was unavailable.
   */
  bars?: { labels: string[]; counts: number[]; colors: (string | null)[] | null };
  /**
   * Stacked-bar distribution for unordered discrete columns (object/string,
   * unordered categorical, bool): the top values by count plus an "(other)"
   * bucket, with a qualitative palette (no order implied). `unique` is the full
   * distinct-value count; `colors` is null if matplotlib was unavailable.
   */
  segments?: {
    labels: string[];
    counts: number[];
    colors: (string | null)[] | null;
    unique: number;
    /** True when every value occurs exactly once (the column has no repeats). */
    allUnique: boolean;
  };
}

/** Webview -> extension host */
export interface ColorizeChoices {
  colormap?: string;
  center?: boolean;
  columnwise?: boolean;
  colorizeNumeric?: boolean;
  colorizeDatetime?: boolean;
  colorizeCategorical?: boolean;
  colorizeText?: boolean;
}

export type WebviewMessage =
  // `sort`/`filter` are per-view (not persisted), so they ride on ready/refresh.
  | ({ type: 'ready'; sort: SortKey[]; filter: string } & ColorizeChoices)
  | ({ type: 'refresh'; sort: SortKey[]; filter: string } & ColorizeChoices)
  | { type: 'rows'; chunk: number }
  /** Persist Colorize UI choices so they carry over to the next view. */
  | {
      type: 'settings';
      colormap: string;
      center: boolean;
      columnwise: boolean;
      colorizeNumeric: boolean;
      colorizeDatetime: boolean;
      colorizeCategorical: boolean;
      colorizeText: boolean;
    };

/** Extension host -> webview */
export type HostMessage =
  | {
      type: 'init';
      fileName: string;
      /** Optional extra status text, e.g. a truncation notice. */
      note?: string;
      columns: string[];
      rowCount: number;
      /** Total rows in the full (filtered) data, before MAX_ROWS truncation. */
      total: number;
      /** First rows, used for column width/type estimation and initial paint. */
      sample: string[][];
      /** Cell colors for the sample rows, or null when Colorize is off. */
      sampleColors: (string | null)[][] | null;
      /** Per-column dtype info aligned to `columns` (index first), or null. */
      columnTypes: ColumnType[] | null;
      /** Per-column summary stats aligned to `columns` (index first), or null. */
      stats: ColumnStat[] | null;
      /** Example query expression for the filter-hint placeholder, or null. */
      filterHint: string | null;
      /** pandas error from a failed filter query (data shown unfiltered), or null. */
      filterError: string | null;
    }
  | {
      type: 'rows';
      chunk: number;
      rows: string[][];
      /** Cell colors aligned to `rows`, or null when Colorize is off. */
      colors: (string | null)[][] | null;
    }
  | { type: 'error'; message: string };
