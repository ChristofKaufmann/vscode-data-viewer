# Changelog

## v0.0.2

- Published under the id `vscode-data-viewer`. No functional changes from v0.0.1.

## v0.0.1

- Open **Jupyter variables** (`DataFrame`/`Series`/`ndarray`/`list`/`dict`) from
  the Jupyter extension's Variables panel, and **debugger variables**
  ("View Value in Data Viewer" in the debug Variables pane)
- Supported file types (right-click → **Open in Data Viewer**):
  - **CSV / TSV** via `pandas.read_csv` (delimiter auto-detected: comma,
    semicolon, tab, pipe)
  - **JSON Lines** (`*.jsonl`/`*.ndjson`) via `pandas.read_json`
  - **Parquet** (`*.parquet`/`*.pq`) and **Feather / Arrow**
    (`*.feather`/`*.arrow`) via PyArrow
  - **NumPy** (`*.npy`/`*.npz`) — a single array, or several equal-length
    1-D arrays as columns
  - **Compressed** variants (`.gz`/`.bz2`/`.zip`/`.xz`/`.zst`/`.tar` and
    `.tar.*`) — pandas infers the compression
- Table:
  - **Virtualized rendering** — only visible rows are materialized, so large
    files scroll smoothly (truncated to the first 100,000 rows)
  - Sticky header and index column, theme-aware styling
  - **dtype glyph** per column header (hover for the full dtype, e.g. `float64`)
  - The DataFrame index as the leftmost column (a MultiIndex shows its level
    names joined with ", ")
  - Numeric columns detected and right-aligned
  - Adjustable column widths (drag the header edge, double-click to auto-fit)
  - Status bar with row/column counts
  - **Refresh** to reload from the source (re-reads files, re-queries the
    kernel — survives a kernel restart)
- **Sort** — click a column's sort handle to cycle ascending/descending; add
  more columns for a stable multi-key sort (ordered categoricals sort by rank)
- **Filter** — a pandas `DataFrame.query` expression with bare column names
  (`&`/`|`, comparisons, `.isna()`/`.notna()`, `index`); a bad expression shows
  the error inline and leaves the data unfiltered
- **Statistics** (the **Stats** toggle, on by default) — computed in Python over
  the full (filtered) data, so they stay exact even when the view is truncated:
  - **Missing / available** split bar and ratio per column
  - **Distributions** per column, as an inline SVG with a hover bubble:
    - a histogram for numeric columns,
    - a calendar-/duration-aware histogram for datetime/timedelta,
    - one bar per category for ordered categoricals, and
    - a stacked bar (top values + "(other)") for unordered text/categorical/bool
  - **Quick filter** — click a histogram bin, a bar, or a missing/available
    segment to append its clause to the filter (joined with `&`)
- **Colorize** (the **Colorize** toggle) — color cells and graphs by value via
  matplotlib:
  - Per-type toggles: **numeric**, **datetime**, **ordered** (categorical, by rank), and
    **unordered** (text/categorical/bool, by value)
  - **Colormap** selector (any useful matplotlib colormap) with preview swatches
  - **Center at 0** — a symmetric range, for numeric and timedelta columns (not
    datetime, whose origin is arbitrary)
  - **Columnwise** — a separate range per column, instead of one shared range
    per type group (numeric, datetime, timedelta)
  - Choices persist across views
