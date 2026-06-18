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
   * Histogram for numeric/datetime/timedelta columns (over non-null values), or
   * absent otherwise. `edges` (length `counts.length + 1`) and `min`/`median`/
   * `max` are *numeric positions* for geometry — the value itself for numeric, or
   * epoch-/total-seconds for datetime/timedelta. For numeric columns the edges
   * are a "nice" rounded grid shown verbatim; datetime/timedelta instead carry
   * `labels` (date / duration strings) that the webview displays in place of the
   * numbers, with calendar-/duration-aware bin boundaries. `colors` tint each bar
   * by its bin center on the colormap (null if matplotlib was unavailable).
   */
  histogram?: {
    counts: number[];
    edges: number[];
    colors: (string | null)[] | null;
    min: number;
    median: number;
    max: number;
    labels?: { edges: string[]; min: string; median: string; max: string };
    /** A pandas `query` clause per bin (`col >= lo & col < hi`) for click-to-filter. */
    filters?: (string | null)[] | null;
  };
  /**
   * Bar chart for ordered-categorical columns: one entry per category, in
   * category (rank) order. `colors` are the colormap sampled at each
   * rank (a "#rrggbb" per bar), or null if matplotlib was unavailable.
   * `filters` is a `col == value` query clause per category (click-to-filter).
   */
  bars?: {
    labels: string[];
    counts: number[];
    colors: (string | null)[] | null;
    filters?: (string | null)[] | null;
    /** Distinct observed values (nonzero categories), for the unique-count caption. */
    unique: number;
    /** True when every observed value occurs exactly once. */
    allUnique: boolean;
  };
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
    /**
     * A `col == value` query clause per kept value (click-to-filter); the
     * "(other)" segment, having no single value, is null.
     */
    filters?: (string | null)[] | null;
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
  /** Persist view-UI choices (Colorize + stats-row toggles) for the next view. */
  | {
      type: 'settings';
      colormap: string;
      center: boolean;
      columnwise: boolean;
      colorizeNumeric: boolean;
      colorizeDatetime: boolean;
      colorizeCategorical: boolean;
      colorizeText: boolean;
      showMissing: boolean;
      showGraphs: boolean;
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
