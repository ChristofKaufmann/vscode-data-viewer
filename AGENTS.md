# AGENTS.md

Non-obvious internals — the *why* behind the design and the gotchas that aren't visible in the code. For setup/build/test see [CONTRIBUTING.md](CONTRIBUTING.md); for the feature list see the [README](README.md) and [CHANGELOG](CHANGELOG.md). The per-feature *mechanics* (rendering, geometry, formatting) are intentionally left to the code — this file keeps the rationale and the traps.

## Mental model

- **Read-only viewer.** It never writes data back; sorting and filtering are *view* operations, not edits.
- **pandas is the single data engine.** Every entry point — data files, Jupyter variables, debugger variables — funnels through one generated Python snippet (`buildDumpCode` in `src/pandasTable.ts`) that emits one JSON payload. There is no second code path: a CSV is just `pd.read_csv(...)` fed into the same serialization as a kernel variable. Keep it that way — features should be pandas operations in `buildDumpCode`, not TypeScript reimplementations.
- Consequence: **viewing anything needs a Python env with pandas + NumPy** (NumPy backs the histograms and `*.npy`/`*.npz` loading; plus matplotlib for Colorize, pyarrow for Parquet/Feather). No pure-JS fallback, by design.

## Architecture

Host: `extension.ts` (activation, `dataViewer.open`) · `pandasTable.ts` (the shared pandas path + payload contract) · `jupyterVariableViewer.ts` (kernel variables, and `openDebugVariable` for the debugger) · `tableEditorProvider.ts` (file `CustomReadonlyEditorProvider`) · `pythonRunner.ts` (interpreter resolution) · `colorizeSettings.ts` (persisted view UI: Colorize options + the Stats toggle) · `tableHost.ts` (vscode-free message loop) · `tableWebview.ts` (the vscode adapter: HTML, CSP, settings).

Webview (`src/webview/`): `main.ts` (virtualized table, DOM glue, *not* unit-tested) and the pure DOM-free helpers that hold the testable logic — `columns.ts`, `contrast.ts`, `colormaps.ts`, `dtypes.ts`, `sorting.ts`, `stats.ts`. Shared: `shared/protocol.ts` (typed host↔webview messages).

## Data flow

```text
file      → tableEditorProvider.loadData ─┐
variable  → jupyterVariableViewer ────────┤─ buildDumpCode → run Python → JSON payload
debugger  → openDebugVariable (DAP) ──────┘                                   │
                                                                  parsePayload + toTable
                                                                              │
                                                              TableData (host, full rows)
                                                                              │  chunked
                                                         createTableHost ⇄ webview/main.ts
```

The host holds the **full** parsed rows; the webview gets only `CHUNK_SIZE` (500) rows at a time plus a small `init` sample. Don't ship whole datasets across the boundary. `createTableHost` is deliberately **vscode-free** so it's unit-testable.

**Invariant — index is column 0.** Everything the webview sees is aligned to `columns = [indexName, ...dataColumns]`: `toTable` prepends the index value (and a `null` color) to each row, Python ships the index dtype as `columnTypes[0]`, and the webview styles column 0 as `indexcol` and never colors it. Any new per-column array must be index-first and the same length, or columns silently misalign.

## The generated Python (`buildDumpCode`)

The trickiest file. It builds Python as an **array of string lines** joined with `\n`, wrapped in one temp function (`_VSCODE_dataviewer_dump`) deleted after running, so a kernel's namespace only gains/loses one name. When editing:

- **Indentation is literal** in the strings — mind the 4/8/12/16-space prefixes.
- **Inject values with `JSON.stringify`** (a JSON string literal is a valid Python string literal) — injection-safe for paths, colormap names, filter expressions.
- **Stay resilient** — the colors/stats/types blocks are each `try/except`-wrapped so a kernel without matplotlib still renders the table (the optional feature degrades to `null`). Don't let it throw.
- **`_raw` vs `head`** — datetimes/timedeltas are stringified for *display* (`_vscode_fmt`), but colors/dtypes/stats need the **original dtypes**, so `_raw` keeps the pre-stringified frame. Compute from `_raw`, build table JSON from `head`. Easy bug.
- **Datetime/timedelta → int** normalizes via `astype("datetime64[ns]")`/`timedelta64[ns]` **before** `astype("int64")` — a bare `int64` cast is *not* nanoseconds for `[s]`/`[us]` columns and silently mis-scales. `np.isnat` masks NaT (numpy route is intentional: `Series.isna()` vs `Index.isna()` differ).
- The query-clause helpers `_qcol`/`_lit`/`_rhs` are defined once, high up, and reused by the filter-hint placeholder, the quick-filter clauses, and the missing-bar `naFilter` — column quoting and literal formatting live in one place.

**Verification loop** (run a Python change against real pandas without launching the extension):

```bash
npx esbuild src/pandasTable.ts --bundle --platform=node --format=cjs --outfile=/tmp/pt.cjs
node -e '
  const m = require("/tmp/pt.cjs");
  const { execFileSync } = require("child_process");
  const py = process.env.PYTHON || "python3";   // an env with pandas/matplotlib
  const code = "import pandas as pd, numpy as np\n" +
    m.buildDumpCode("pd.DataFrame({\"a\":[1,2],\"b\":[3.0,4.0]})");
  const t = m.toTable(m.parsePayload(execFileSync(py, ["-c", code], {encoding:"utf8"})));
  console.log(JSON.stringify(t, null, 2));
'
```

Reach for this (bundle → run through pandas → inspect `toTable`) before wiring anything into the UI.

## Colorize

Defining decision: **colors are computed in Python, not JS** — the payload carries per-cell `#rrggbb`/`null`. So switching colormap is a one-liner (any matplotlib name), but anything that changes the colors (colormap, center, columnwise, the per-type toggles) needs a **reload** (re-run Python via `LoadOptions` on `ready`/`refresh`); only *painting* loaded colors is client-side. That's why the toggles reload rather than instant-toggle — one consistent model.

Range-grouping invariants (in `buildDumpCode`):

- **numeric**, **datetime**, **timedelta** are *separate* range groups (each in its own unit, so a ~1e18 ns timestamp never crushes a numeric column). Shared within a group, or per-column when **Columnwise** is on.
- **Ordered categoricals** are colored by code over the full `0..n-1` category range, and are **always per-column**.
- **Unordered/text/bool** (`_do_unord`) are colored *qualitatively* from the same `_nominal_info` map that drives the stacked-bar distribution — reused so a value's bar color and cell color can't diverge.
- **Centering is skipped** for datetime (epoch 0 is meaningless) and categorical (0 is just the first category); it applies to numeric and timedelta.

The colormap preview swatches use a hardcoded `CMAP_STOPS` LUT in `colormaps.ts` — if you change the offered colormaps in `tableWebview.ts`, regenerate it from matplotlib (16 stops/map) so the two stay in sync.

## Sorting & filtering

Both are pandas operations in `buildDumpCode`, so both **reload** and get dtype-correct behavior for free, and both are **per-view** (ride on `ready`/`refresh`, not persisted — survive a refresh, reset on a new source).

- **Sort**: a stable multi-key `sort_values`; the webview holds `SortKey[]` (primary first; `column` is a data-column position, **-1 = index**), cycle logic in the pure `sorting.ts`. It `reset_index`es, sorts by integer column positions (duplicate-name safe), then reorders the *original* frame via `.iloc` (preserving index/names/dtypes). Uncomparable column → silently unsorted (`try/except`).
- **Filter**: `obj.query(expr, engine="python")`, applied **before** sort/head so the count reflects the filtered total. `engine="python"` is deliberate (string/datetime/categorical comparisons + `.isna()`/`.notna()`). Bare column names resolve identically for files and variables — that's why we never use the variable name or `eval`. A bad expression is **surfaced** (not silently dropped): runs in its own `try/except`, data left unfiltered, the pandas error rides back as `filterError`.

## Column statistics

Unlike Colorize/sort/filter, stats do **not** reload: they're computed over the **full filtered `obj`** (before `head(MAX_ROWS)`, so exact on big tables), shipped in `stats` (index-first like `columnTypes`), and always present — so the **Stats** toggle (`body.stats-hist`, persisted, default on) is pure client-side CSS show/hide.

A column gets exactly **one** distribution shape: `histogram` (numeric, datetime, **and** timedelta), `bars` (ordered categorical), or `segments` (other discrete). The drawing/geometry/number-formatting all live in the pure `webview/stats.ts` (`histogramSvg`, `stackedBarSvg`, `tickStripSvg`, `naBar`, `markerFraction`, `binIndexAt`, `formatNumber`, …) — read it there rather than duplicating the mechanics here. The non-obvious bits worth knowing:

- **Datetime/timedelta histograms** use **calendar-/duration-aware** bin edges (`_date_edges`/`_td_step`), and the payload splits numeric *position* (`edges`/`min`/`median`/`max`, in seconds) from display *label* strings — so all the geometry is unit-agnostic while the axis shows dates/durations.
- **Histogram/ordinal-bar tint follows the Colorize type toggle** (numeric→`colorizeNumeric`, datetime/timedelta→`colorizeDatetime`, ordered→`colorizeOrdered`); off → `colors: null` and the default fill. The **stacked bar is always colored** — a single-fill stacked bar is one indistinguishable block, so its palette is essential, not decorative.
- **Quick filter**: each distribution ships a `filters` array (one `query` clause per bin/value, built in Python with the shared helpers); a delegated `click` on `#stats-row` **appends** the clause to the filter with ` & ` (parenthesizing one that has its own operator). Scoped via `closest('svg.hist, svg.stacked')` so labels/captions stay selectable.
- **Missing/available split bar**: rendered as flex `<div>`s, *not* a stretching SVG, specifically so a minority segment keeps an **absolute px `min-width`** when the column is resized (a `preserveAspectRatio="none"` SVG would scale that minimum away). Counts are derived in the webview (`rowTotal − missing`); only the `notna()`/`isna()` clauses (`naFilter`) come from Python.
- Per-bin info uses a **custom hover bubble** (`#hist-bubble`, `position:fixed` on `<body>`, `pointer-events:none`) driven by a delegated `mousemove` that maps cursor x to a bin/segment — no per-bar hit targets.

When adding a stat: extend `ColumnStat` and the Python `stats` list together, render it in `buildStatsRow`, and keep formatting/geometry in `webview/stats.ts` so it's unit-tested.

## Webview specifics

- **Pure modules are the testable core** (`columns.ts`, `contrast.ts`, `colormaps.ts`, `dtypes.ts`, `sorting.ts`, `stats.ts`, `tableHost.ts`, `colorizeSettings.ts` — the last imports vscode as a **type only**). `main.ts` is DOM glue, not unit-tested. Adding logic → extract the pure part.
- **Settings persistence**: Colorize choices and the Stats toggle live in `context.globalState` (`colorizeSettings.ts`, key `dataViewer.colorize`). The toolbar **Colorize** button is a **derived select-all toggle** (active when any colorize flag is on) — no separate `enabled` state to sync.
- **CSP/CSSOM**: inline `style=` *attributes* in the HTML are blocked by `style-src`, so per-element colors/gradients are set from the DOM via `.style.*` (CSSOM), which is allowed. Colorize backgrounds are inline (override the zebra stripe; also why hover doesn't recolor a colorized cell). The row-hover rule must out-specify the `.row.alt .cell:not(.indexcol)` stripe — `test/styles.test.ts` guards that.
- **Column widths** are an *estimate* (`CHAR_PX` px/char + bold-header factor), no text measurement; manual widths are remembered by **column name** so they survive a refresh.
- **Codicons**: dtype glyphs use VS Code's bundled codicon font — `esbuild.js` copies `codicon.css`/`.ttf` into `dist/codicons/` (gitignored), the webview links it, CSP allows `font-src`. If glyphs vanish, check those three.

## Integration gotchas

**Jupyter variables** (`jupyterVariableViewer.ts`): registered via the `jupyterVariableViewers` contribution point (the command gets one `IJupyterVariable`-shaped arg; `dataTypes` are short class names). First kernel access triggers a consent prompt — denial throws `name === 'vscode.jupyter.apiAccessRevoked'`, handled with a friendly message. The kernel API's doc comment advertises one stdout MIME but emits `application/vnd.code.notebook.stdout`; we accept **both** plus a `text/plain` fallback (suspect this if "kernel returned no data" returns). The kernel is re-acquired each load, so refresh survives a restart. The panel tab icon is set via `panel.iconPath` (file views are custom editors and get the file-type icon instead).

**Debugger variables** (`openDebugVariable`): the same command also fires from the debugger's Variables pane, distinguished by a `frameId`. No kernel, so it goes over the **Debug Adapter Protocol** (`activeDebugSession.customRequest`). DAP `evaluate` returns a value only for a single *expression* and no stdout, so the script is built with `outputFile` (writes JSON to a temp file) and wrapped as one expression: `exec(base64-decoded-source, {**globals(), **locals()})` — base64 dodges quoting, the merged namespace exposes the target frame-local to the generated function. A `frameId` is valid only while paused there, so each load **re-resolves the thread's current top frame** via `stackTrace` (thread found once by scanning for the original `frameId`); stepping keeps Refresh working.

**File path** (`tableEditorProvider.ts` / `pythonRunner.ts`): interpreter from the Python extension's selected env, falling back to `python3`; logged to the "Data Viewer" output channel. A missing package raises `PythonEnvironmentError` → a "Select Interpreter" retry loop. CSV can't carry an ordered-categorical dtype (read_csv yields strings) — exercise that via a Jupyter variable (`sample-data/jup-vars.py`).

- **Adding a file format**: add the extension to the `dataViewer.table` `customEditors` selector and the `explorer/context` `when` clause in `package.json`, then pick the read expression by extension in `loadData`. Every format is **opt-in** (`priority: option`), reached via right-click → **Open in Data Viewer** or **Reopen Editor With…**, so it never claims a file as the default editor. Downstream is format-agnostic — a read expression just has to yield something `pd.DataFrame(...)` accepts. NumPy is the one reader needing a preamble helper (`_read_numpy`): `np.load(allow_pickle=False)`, then a lone array → DataFrame (1-D → one column, >2-D collapsed) or a multi-array `.npz` → DataFrame of named columns.
- **Compression** is mostly free (pandas infers it from the path; selectors add brace-glob variants, `loadData` strips the suffix before the format check). The catch: the CSV delimiter sniff must read the *decompressed* sample (`pandas.io.common.get_handle`), with a `sep=None` fallback.
