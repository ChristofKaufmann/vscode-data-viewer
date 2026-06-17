# Changelog

## v0.0.1

- View **Jupyter variables** (pandas DataFrame/Series, ndarray, list, dict) from the
  Jupyter extension's VARIABLES panel — click the data viewer icon next to a variable
- View **CSV/TSV** files in a table, loaded with `pandas.read_csv` (delimiter
  auto-detected: comma, semicolon, tab, pipe) so files behave exactly like
  DataFrames viewed from a kernel
- View **JSON Lines** (`*.jsonl`/`*.ndjson`) via `pandas.read_json(lines=True)`
  (right-click → **Open in Data Viewer**, like CSV)
- View **Parquet** (`*.parquet`/`*.pq`) and **Feather** (`*.feather`) files via
  `pandas.read_parquet`/`read_feather` — the viewer opens them by default (needs
  `pyarrow`, or `fastparquet` for Parquet, in the interpreter). `*.arrow` files
  open via right-click → **Open in Data Viewer**
- **Compressed** files are handled too — pandas infers the compression, so
  `data.csv.gz`, `sales.tsv.bz2`, `t.parquet.zip`, etc. (`.gz`/`.bz2`/`.zip`/
  `.xz`/`.zst`/`.tar` and `.tar.*`) open like their uncompressed forms
- **Colorize mode** (the **Colorize** toolbar button, on by default) — cells are
  colored by value, computed in pandas/matplotlib. The **Colorize** button is a
  select-all toggle (active when any type is colored) over four type toggles in
  the popover: **Colorize numeric**,
  **Colorize datetime** (by timestamp), **Colorize categorical** (ordered
  categoricals only, by rank), and **Colorize text** (unordered/text/bool cells
  by value, using the same qualitative palette as their distribution bar — tail
  values get its gray "(other)"). Numeric, datetime and timedelta columns each
  form a separate value-range group so they never distort each other; ordered
  categoricals are ranked per column over their full set of categories.
  A chevron button opens the popover with those toggles plus a **colormap** selector
  (viridis, plasma, coolwarm, …) with a small preview swatch, a **Center at 0**
  toggle (symmetric range, useful
  with diverging colormaps), and a **Columnwise** toggle (a separate vmin/vmax per
  column instead of one per group). NaN/NaT cells stay uncolored;
  changing any option recomputes colors in Python on reload. All choices are
  remembered (extension global state) and carry over to the next view.
  (`DEFAULT_COLORMAP` in `pandasTable.ts` sets the default colormap.)
- **Virtualized rendering** — only visible rows are materialized, so large files scroll smoothly
- Toolbar with a **refresh** button that reloads from the original source (re-runs
  `read_csv` for files, re-queries the kernel for variables — picking up edits and
  surviving a kernel restart)
- **Sorting** — click the handle on the right of any column header (the index
  included) to cycle no-sort → ascending → descending. Clicking another column
  adds it as the new primary key (a stable multi-column sort, done by pandas, so
  ordered categoricals sort by rank); a priority number shows the order
- **Filtering** — the funnel button opens a filter bar taking a pandas
  `DataFrame.query` expression with bare column names, e.g.
  `(founded < 0 | founded > 1000) & last_census.notna()` — supports `&`/`|`,
  comparisons, `.isna()`/`.notna()`, ordered-categorical comparisons, and `index`;
  a bad expression shows the error inline and leaves the data unfiltered.
  Clicking the funnel again hides the bar and disables the filter temporarily
  (the data goes back to unfiltered) while keeping the expression; clicking once
  more re-applies it
- **Column statistics** — sub-rows under the header (on by default), computed in
  pandas over the full (filtered) data so they stay exact even when the view is
  truncated, update with the filter, and toggle instantly (no reload):
  - **Missing values** (**Σ** button): the missing-value count per column with
    its share of the rows, e.g. `3 (30%)`
  - **Distributions** (**graph** button): a small chart per column, drawn as an
    inline SVG that scales to the column width, with an immediate hover bubble
    over each bar.
    - *Numeric* columns get a histogram (`np.histogram` over non-null values,
      binned on a "nice" rounded grid of ≈16 bins so the edges are readable
      round numbers); empty bins keep a minimum bar so the full spread stays
      visible, and tick marks with **min / median / max** labels sit below.
    - *Datetime / timedelta* columns get the same histogram, but with
      **calendar-/duration-aware** bins (year/month/day/hour… boundaries for
      dates, nice durations for timedeltas) and date/duration labels.
    - *Ordinal* (ordered-categorical) columns get one bar per category in
      category order (`value_counts`), each tinted with the colormap at
      its rank, so the colors read as a left→right gradient.
    - *Unordered* discrete columns (text/string, unordered categorical, bool)
      get a horizontal stacked bar — the most frequent values plus an "(other)"
      bucket, with a qualitative palette (no order implied) and a caption with
      the distinct-value count (e.g. "all 10 unique" when the column has no
      repeats). Values are kept a whole count-level at a time (so
      equal-frequency ties stay together) until a level would overflow the
      available colors, at which point it and everything rarer become "(other)".
- Adjustable column widths (drag the header edge, double-click to auto-fit)
- First row is treated as the header
- Each column header (the index too) shows a dimmed **dtype glyph** — codicon
  icons for numeric/text/bool/datetime/categorical (the icon font VS Code ships)
  and `Δ` for timedelta; hover it for the full dtype (e.g. `float64`,
  `datetime64[ns]`)
- The DataFrame index is shown as the leftmost column, labelled with the index
  name (a MultiIndex shows its level names joined with ", "; blank when unnamed)
- Numeric columns are detected and right-aligned
- Sticky header and index column, theme-aware styling
- Status bar with row/column counts
- pandas is the single data engine: both paths run the same serialization code,
in the notebook's kernel for variables and in the selected Python interpreter
(falling back to `python3`) for files. Viewing files therefore requires a
Python environment with pandas installed.
