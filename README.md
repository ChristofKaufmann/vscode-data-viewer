# Data Viewer

A minimal VS Code extension for viewing tabular data files — read-only for now,
in the spirit of Data Wrangler but starting small.

## Features (v0.0.1)

- View **CSV/TSV** files in a table (delimiter auto-detected: comma, semicolon, tab, pipe)
- View **Jupyter variables** (pandas DataFrame/Series, ndarray, list, dict) from the
  Jupyter extension's VARIABLES panel — click the data viewer icon next to a variable
- **Virtualized rendering** — only visible rows are materialized, so large files scroll smoothly
- First row is treated as the header
- Numeric columns are detected and right-aligned
- Sticky header and row numbers, theme-aware styling
- Status bar with row/column counts

## Usage

- Right-click a `.csv`/`.tsv` file in the explorer → **Open in Data Viewer**
- Or right-click an editor tab → **Reopen Editor With… → Data Viewer**
- Or run **Data Viewer: Open in Data Viewer** from the command palette

The default (text) editor is untouched; the viewer is opt-in per file.

For Jupyter variables: open a notebook, run a cell, open the **Jupyter → Variables**
panel and click the table icon next to a DataFrame. The first use prompts you to
grant this extension access to Jupyter kernels (managed later via
**Jupyter: Manage Access To Jupyter Kernels**). Large frames are truncated to the
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
- `src/tableEditorProvider.ts` — `CustomReadonlyEditorProvider`; parses the file
  with papaparse in the extension host and serves rows to the webview in chunks
- `src/jupyterVariableViewer.ts` — registered via the `jupyterVariableViewers`
  contribution point; pulls the variable out of the kernel as JSON via the
  Jupyter extension's kernel API (`@vscode/jupyter-extension`)
- `src/tableWebview.ts` — shared webview setup + chunked row serving
- `src/webview/main.ts` — virtualized table; requests only the visible row
  chunks and caches a bounded number of them
- `src/shared/protocol.ts` — typed messages between host and webview

Keeping parsing and row storage in the extension host (instead of shipping the
whole file into the webview) is groundwork for later features like sorting,
filtering, and column statistics.

## Ideas for later

- Sorting and filtering
- Parquet / Excel / JSON Lines support
- Column statistics and type inference
- Header on/off toggle, encoding selection
- Live reload when the file changes on disk
