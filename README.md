# Data Viewer

View tabular Jupyter variables and data files.

## Main Features

- View data in a **tabular grid** with sticky index and column headers.
- Show **dtype** and number of **missing values** per column.
- **Sort** with multiple keys.
- Draw distribution **graphs** for each column, depending on data type:
  - Numeric column → Histogram
  - DateTime or TimeDelta column → Histogram
  - Ordered Categorical column → Bar Plot
  - String or Boolean column → Stacked Bar Plot
- **Quick filter** data from the distribution graphs.
- **Colorize** cells and graphs using a colormap with many settings.
- **Filter** using [Pandas' query syntax](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.query.html).

## Usage

- **Parquet** files open in the viewer directly (it's their default editor)
- For **CSV/TSV** (the text editor stays the default): right-click the file →
  **Open in Data Viewer**, or right-click an editor tab → **Reopen Editor
  With… → Data Viewer**, or run **Data Viewer: Open in Data Viewer** from the
  command palette

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
busy guard against overlapping reloads), Colorize text-contrast helper
(`contrast.ts`), and a specificity guard for the row-hover CSS fix.

Press **F5** in VS Code to launch an Extension Development Host with the
extension loaded, then open `sample-data/cities.csv` with it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the non-obvious internals — the
pandas-engine model, the generated-Python rules, Colorize reload model, and
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
- `src/colorizeSettings.ts` — reads/writes the persisted Colorize on/off and
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
  colored cell background
- `src/webview/dtypes.ts` — maps a column's dtype kind to its header glyph
- `src/shared/protocol.ts` — typed messages between host and webview

Row storage stays in the extension host (instead of shipping everything into
the webview), and pandas being the single engine means later features like
sorting, filtering, and column statistics can be pandas operations with
identical behavior for files and variables.
