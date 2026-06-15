# Data Viewer

A minimal VS Code extension for viewing tabular data files — read-only for now,
in the spirit of Data Wrangler but starting small.

## Features (v0.0.1)

- View **Jupyter variables** (pandas DataFrame/Series, ndarray, list, dict) from the
  Jupyter extension's VARIABLES panel — click the data viewer icon next to a variable
- View **CSV/TSV** files in a table, loaded with `pandas.read_csv` (delimiter
  auto-detected: comma, semicolon, tab, pipe) so files behave exactly like
  DataFrames viewed from a kernel

- **Heatmap mode** (toolbar checkbox, on by default) — cells are colored by value,
  computed in pandas/matplotlib. The toolbar **Heatmap** checkbox is a tri-state
  select-all over three type toggles in the popover: **Colorize numeric**,
  **Colorize datetime** (by timestamp), and **Colorize categorical** (ordered
  categoricals only, by rank). Numeric, datetime and timedelta columns each form a
  separate value-range group so they never distort each other; ordered categoricals
  are ranked per column over their full set of categories.
  A gear button opens the popover with those toggles plus a **colormap** selector
  (viridis, plasma, coolwarm, …) with a small preview swatch, a **Center at 0**
  toggle (symmetric range, useful
  with diverging colormaps), and a **Columnwise** toggle (a separate vmin/vmax per
  column instead of one per group). Non-numeric/NaN/NaT cells stay uncolored;
  changing any option recomputes colors in Python on reload. All choices are
  remembered (extension global state) and carry over to the next view.
  (`HEATMAP_CMAP` in `pandasTable.ts` sets the default colormap.)
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
  a bad expression shows the error inline and leaves the data unfiltered
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

pandas is the single data engine: both paths run the same serialization code,
in the notebook's kernel for variables and in the selected Python interpreter
(falling back to `python3`) for files. Viewing files therefore requires a
Python environment with pandas installed.

## Usage

- Right-click a `.csv`/`.tsv` file in the explorer → **Open in Data Viewer**
- Or right-click an editor tab → **Reopen Editor With… → Data Viewer**
- Or run **Data Viewer: Open in Data Viewer** from the command palette

The default (text) editor is untouched; the viewer is opt-in per file.

For Jupyter variables: open a notebook, run a cell, open the **Jupyter → Variables**
panel and click the table icon next to a DataFrame. The first use prompts you to
grant this extension access to Jupyter kernels (managed later via
**Jupyter: Manage Access To Jupyter Kernels**). Data is truncated to the
first 100,000 rows for now; the status bar says so when it happens.

## Development

```bash
npm install
npm run build     # bundle extension + webview with esbuild
npm run watch     # rebuild on change
npm run typecheck # tsc --noEmit
npm test          # unit tests (node:test via tsx)
```

Unit tests live in `test/` and cover the pure logic: the pandas data path
(`pandasTable.ts` — index handling, cell formatting, truncation, output
parsing, generated Python), the webview column helpers (`columns.ts` — numeric
detection, widths, index/sticky cell classes), the load/refresh message loop
(`tableHost.ts` — init sampling, chunk slicing, refresh, error handling, and the
busy guard against overlapping reloads), the heatmap text-contrast helper
(`contrast.ts`), and a specificity guard for the row-hover CSS fix.

Press **F5** in VS Code to launch an Extension Development Host with the
extension loaded, then open `sample-data/cities.csv` with it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the non-obvious internals — the
pandas-engine model, the generated-Python rules, the heatmap reload model, and
the test/verification workflow.

## Architecture

- `src/extension.ts` — activation, `dataViewer.open` command
- `src/pandasTable.ts` — the shared pandas path: Python code that serializes a
  DataFrame-like object as JSON, and the TypeScript that turns the payload
  into table columns/rows
- `src/jupyterVariableViewer.ts` — registered via the `jupyterVariableViewers`
  contribution point; runs the dump code in the notebook's kernel via the
  Jupyter extension's kernel API (`@vscode/jupyter-extension`)
- `src/tableEditorProvider.ts` — `CustomReadonlyEditorProvider`; runs the same
  dump code with `pd.read_csv` in a Python subprocess
- `src/pythonRunner.ts` — resolves the interpreter (Python extension API,
  fallback `python3`) and runs scripts
- `src/heatmapSettings.ts` — reads/writes the persisted heatmap on/off and
  colormap in the extension's global state
- `src/tableWebview.ts` — wires a real webview to the table host (HTML, CSP,
  `postMessage`, error notifications)
- `src/tableHost.ts` — the webview message loop (load/refresh/serve chunks),
  kept vscode-free so it can be unit-tested
- `src/webview/main.ts` — virtualized table; requests only the visible row
  chunks and caches a bounded number of them
- `src/webview/columns.ts` — pure column helpers (numeric detection, widths,
  cell classes), kept DOM-free so they can be unit-tested
- `src/webview/contrast.ts` — pure helper picking black/white text for a
  heatmap background color
- `src/webview/dtypes.ts` — maps a column's dtype kind to its header glyph
- `src/shared/protocol.ts` — typed messages between host and webview

Row storage stays in the extension host (instead of shipping everything into
the webview), and pandas being the single engine means later features like
sorting, filtering, and column statistics can be pandas operations with
identical behavior for files and variables.

## Ideas for later

- Parquet / Excel / JSON Lines support
- Column statistics
