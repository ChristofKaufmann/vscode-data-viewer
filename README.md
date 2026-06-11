# Data Viewer

A minimal VS Code extension for viewing tabular data files — read-only for now,
in the spirit of Data Wrangler but starting small.

## Features (v0.0.1)

- View **Jupyter variables** (pandas DataFrame/Series, ndarray, list, dict) from the
  Jupyter extension's VARIABLES panel — click the data viewer icon next to a variable
- View **CSV/TSV** files in a table, loaded with `pandas.read_csv` (delimiter
  auto-detected: comma, semicolon, tab, pipe) so files behave exactly like
  DataFrames viewed from a kernel

- **Virtualized rendering** — only visible rows are materialized, so large files scroll smoothly
- Adjustable column widths (drag the header edge, double-click to auto-fit)
- First row is treated as the header
- Numeric columns are detected and right-aligned
- Sticky header and row numbers, theme-aware styling
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
```

Press **F5** in VS Code to launch an Extension Development Host with the
extension loaded, then open `sample-data/cities.csv` with it.

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
- `src/tableWebview.ts` — shared webview setup + chunked row serving
- `src/webview/main.ts` — virtualized table; requests only the visible row
  chunks and caches a bounded number of them
- `src/shared/protocol.ts` — typed messages between host and webview

Row storage stays in the extension host (instead of shipping everything into
the webview), and pandas being the single engine means later features like
sorting, filtering, and column statistics can be pandas operations with
identical behavior for files and variables.

## Ideas for later

- Sorting and filtering
- Parquet / Excel / JSON Lines support
- Column statistics and type inference
- Header on/off toggle, encoding selection
- Live reload when the file changes on disk
