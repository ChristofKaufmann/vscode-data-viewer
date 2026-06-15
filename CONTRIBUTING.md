# Contributing

This document captures the non-obvious internals — the *why* behind the design
and the gotchas that aren't visible in the code. For the feature list and the
module map, see the [README](README.md).

## Mental model

- It's a **read-only viewer**. No editing, sorting, or filtering yet.
- **pandas is the single data engine.** Both entry points (CSV/TSV files and
  Jupyter variables) funnel through one generated Python snippet that emits one
  JSON payload. There is no second code path: a CSV is just `pd.read_csv(...)`
  fed into the same serialization as a kernel variable. Keep it that way —
  features should be pandas operations in `buildDumpCode`, not TypeScript
  reimplementations, so files and variables stay identical.
- Consequence: **viewing files needs a Python env with pandas** (and matplotlib
  for the heatmap). There's no pure-JS fallback, by design.

## Data flow

```text
file  → tableEditorProvider.loadData ─┐
                                      ├─ buildDumpCode → run Python → JSON payload
variable → jupyterVariableViewer ─────┘                                   │
                                                              parsePayload + toTable
                                                                          │
                                                          TableData (host, full rows)
                                                                          │  chunked
                                                     createTableHost ⇄ webview/main.ts
```

- `src/pandasTable.ts` owns the payload contract (`buildDumpCode`, `parsePayload`,
  `toTable`, and the `DumpPayload`/`TableContent` types).
- The extension host holds the **full** parsed rows; the webview only ever gets
  `CHUNK_SIZE` (500) rows at a time plus a 100-row sample in `init`. Don't ship
  whole datasets across the webview boundary.
- `src/tableHost.ts` (`createTableHost`) is the message loop, deliberately
  **vscode-free** so it's unit-testable. `src/tableWebview.ts` is the thin vscode
  adapter (HTML, CSP, `postMessage`, notifications, settings).

### The index-as-column-0 invariant

Everything the webview sees is aligned to `columns = [indexName, ...dataColumns]`
— the DataFrame index always rides along as **column 0**:

- `toTable` prepends the index *value* to each row and a `null` index *color*.
- Python includes the index's dtype as `columnTypes[0]`.
- The webview renders column 0 with sticky/`indexcol` styling and never colors it
  in the heatmap.

If you add another per-column array, keep it index-first and the same length, or
the columns silently misalign.

## The generated Python (`buildDumpCode`)

This is the trickiest file to edit. It builds Python as an **array of string
lines** joined with `\n`, wrapped in one temp function (`_VSCODE_dataviewer_dump`)
that is deleted after running, so a kernel's namespace only ever gains/loses one
name.

Rules of thumb when editing it:

- **Indentation is literal** inside the strings. Mind the 4/8/12-space prefixes.
- **Inject values with `JSON.stringify`** (a JSON string literal is also a valid
  Python string literal). This is what keeps file paths and the colormap name
  injection-safe.
- **Stay resilient.** The color/type blocks are each wrapped in `try/except` so a
  kernel without matplotlib (or any surprise) still renders the table — the
  feature just degrades to `null`. Don't let an optional feature throw.
- **`_raw` vs `head`.** Datetimes/timedeltas are stringified for *display* via
  `_vscode_fmt` (so they read like `str()`, not ISO). But color computation and
  dtype detection need the **original dtypes**, so `_raw` keeps a reference to the
  pre-stringified frame. Compute colors/types from `_raw`, build the table JSON
  from `head`. Mixing these up is an easy bug.
- Datetime/timedelta epoch extraction uses `arr.astype("int64")` with
  `np.isnat(arr)` masked to `NaN` — `Series.isna()` vs `Index.isna()` return
  different types, so the numpy route is intentional.

To verify a Python change against real pandas without launching the extension,
bundle just this module and run it through any interpreter that has pandas +
matplotlib:

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

This loop (bundle → run through pandas → inspect `toTable`) is how the data path
has been validated throughout; reach for it before wiring anything into the UI.

## Heatmap

The defining decision: **colors are computed in Python, not JavaScript.** The
payload carries per-cell `#rrggbb`/`null`. Implications:

- Switching colormap is a one-liner (a matplotlib name), and we get all of
  matplotlib's maps for free.
- Anything that changes the *colors* — colormap, center, columnwise, the
  per-type "Colorize …" toggles — requires a **reload** (re-run Python), routed
  through `LoadOptions` on the `ready`/`refresh` messages. Only *painting* the
  already-loaded colors is client-side. So the master Heatmap toggle and friends
  reload rather than instant-toggle; that's intentional, for one consistent model.

Range grouping (in `buildDumpCode`):

- **numeric**, **datetime**, **timedelta** are *separate* range groups — each in
  its own unit, so a timestamp (~1e18 ns) never crushes a numeric column. Within
  a group the range is shared, or per-column when **Columnwise** is on.
- **Ordered categoricals** are colored by code over their full `0..n-1` category
  range (so the top category keeps the brightest color even if absent), and are
  **always per-column**. Unordered categoricals are left uncolored (their code
  order is arbitrary).
- **Centering is skipped** for datetime (the 1970 epoch makes 0 meaningless) and
  categorical (0 is just the first category); it applies to numeric and timedelta.

UI niceties: the colormap preview swatch (`colormaps.ts`) and dtype glyphs use a
hardcoded LUT / icon list. If you change the offered colormaps in
`tableWebview.ts`, regenerate `CMAP_STOPS` from matplotlib (16 stops per map).

## Sorting

Like the heatmap, sorting is done in **pandas** (a `sort_values` in
`buildDumpCode`), so it's a reload and gets dtype-correct ordering for free —
ordered categoricals sort by rank, not alphabetically. The webview holds an
ordered `SortKey[]` (primary first; `column` is a 0-based *data*-column position,
or **-1 for the index**) and the cycle logic lives in the pure `webview/sorting.ts`
(`cycleSort`/`sortState`). One stable multi-key sort covers mixed asc/desc
directions — no need to sort sequentially. The Python `reset_index`es so the
index level(s) become leading columns, relabels every column to an integer
position (duplicate-name safe), runs `sort_values(by, ascending=[...],
kind="stable")`, then reorders the *original* frame by the resulting row
positions with `.iloc` — that preserves the index, its names and all dtypes. An
index key (-1) expands to all its levels (so a MultiIndex sorts lexicographically,
like `sort_index`). The whole thing is wrapped in `try/except` (an uncomparable
mixed-type column just stays unsorted). Sort is **per-view**: it rides on
`ready`/`refresh`, not the persisted settings, so it survives a refresh but
resets on a new variable/file.

## Webview specifics

- **Pure modules are the testable core.** Logic lives in DOM-free/vscode-free
  modules — `columns.ts`, `contrast.ts`, `colormaps.ts`, `dtypes.ts`,
  `tableHost.ts`, `heatmapSettings.ts` (which imports vscode as a **type only**) —
  so `node:test` can exercise them without a browser or editor. `webview/main.ts`
  is the DOM glue and is intentionally *not* unit-tested. When adding logic,
  extract the pure part.
- **Settings persistence:** heatmap choices live in `context.globalState`
  (`heatmapSettings.ts`) so they carry across views/sessions. The toolbar
  "Heatmap" checkbox is a **derived tri-state select-all** over the two/three
  colorize flags — there is no separate `enabled` state to keep in sync.
- **Column widths** are an *estimate* (`CHAR_PX` px/char, with a bold-header
  factor); there's no text measurement. Manually-set widths are remembered by
  **column name** so they survive a refresh.
- **CSS cascade gotchas:** heatmap colors are applied as inline `background-color`
  (so they override the zebra stripe), which also means hover doesn't recolor a
  heatmapped cell. And the row-hover rule must out-specify the
  `.row.alt .cell:not(.indexcol)` stripe rule — `test/styles.test.ts` guards that.
- **Codicons:** the dtype glyphs use VS Code's bundled codicon font. `esbuild.js`
  copies `codicon.css`/`.ttf` into `dist/codicons/` (gitignored), the webview
  links it, and the CSP allows `font-src`. If glyphs vanish, check those three.

## Integration gotchas

Jupyter variable viewer (`jupyterVariableViewer.ts`):

- Registered via the `contributes.jupyterVariableViewers` contribution point;
  the command receives one `IJupyterVariable`-shaped argument. `dataTypes` in
  `package.json` are **short** class names (`DataFrame`, `Series`, …), and the
  keyword `jupyterVariableViewers` is how users find the extension.
- First kernel access triggers a **consent prompt**; denial throws an error whose
  `name` is `vscode.jupyter.apiAccessRevoked` — handled with a friendly message.
- The kernel API's doc comment advertises one stdout MIME, but the implementation
  emits `application/vnd.code.notebook.stdout`. We accept **both** (plus a
  `text/plain` fallback). If "kernel returned no data" reappears, suspect this.
- The kernel is re-acquired on every (re)load, so refresh survives a restart.

CSV path (`pythonRunner.ts`):

- The interpreter is resolved from the Python extension's selected environment,
  falling back to `python3` on PATH. The chosen interpreter is logged to the
  "Data Viewer" output channel.
- A missing pandas raises `PythonEnvironmentError`, which the editor surfaces with
  a **"Select Interpreter"** retry loop. A CSV column can't carry an ordered
  categorical dtype (read_csv yields strings) — exercise that feature via a
  Jupyter variable (see `sample-data/jup-vars.py`).

## Workflow

```bash
npm install
npm run build      # esbuild bundle (also copies codicons)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit, over src/ only
npm test           # node:test via tsx, over test/
```

- **Tests are not type-checked.** `npm test` runs through `tsx` (transpile only),
  and `tsc` only covers `src/`. A test can have a type error and still run — rely
  on `npm test` for behavior, `npm run typecheck` for `src/` types.
- Press **F5** to launch an Extension Development Host; open
  `sample-data/cities.csv`, or run `sample-data/jup-vars.py` in a kernel and open
  its variables.
- Commits in this repo are scoped and incremental, with an imperative subject and
  a short body explaining the *why*; please match that.
