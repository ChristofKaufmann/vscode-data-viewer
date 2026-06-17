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
  for Colorize). There's no pure-JS fallback, by design.

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
  in Colorize.

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

## Colorize

The defining decision: **colors are computed in Python, not JavaScript.** The
payload carries per-cell `#rrggbb`/`null`. Implications:

- Switching colormap is a one-liner (a matplotlib name), and we get all of
  matplotlib's maps for free.
- Anything that changes the *colors* — colormap, center, columnwise, the
  per-type "Colorize …" toggles — requires a **reload** (re-run Python), routed
  through `LoadOptions` on the `ready`/`refresh` messages. Only *painting* the
  already-loaded colors is client-side. So the master Colorize toggle and friends
  reload rather than instant-toggle; that's intentional, for one consistent model.

Range grouping (in `buildDumpCode`):

- **numeric**, **datetime**, **timedelta** are *separate* range groups — each in
  its own unit, so a timestamp (~1e18 ns) never crushes a numeric column. Within
  a group the range is shared, or per-column when **Columnwise** is on.
- **Ordered categoricals** are colored by code over their full `0..n-1` category
  range (so the top category keeps the brightest color even if absent), and are
  **always per-column**.
- **Unordered / text / bool** columns (the **Colorize text** toggle, `_do_text`)
  are colored *qualitatively*, not on a gradient: each cell takes its value's
  color from the **same** `_nominal_info` map that drives the stacked-bar
  distribution (tab10 minus the gray C7), and tail values get the bar's gray
  "(other)". This is a per-value lookup, separate from the gradient machinery
  above — and it reuses `_nominal_info` so a value's bar color and cell color
  can't diverge.
- **Centering is skipped** for datetime (the 1970 epoch makes 0 meaningless) and
  categorical (0 is just the first category); it applies to numeric and timedelta.

UI niceties: the colormap preview swatch (`colormaps.ts`) and dtype glyphs use a
hardcoded LUT / icon list. If you change the offered colormaps in
`tableWebview.ts`, regenerate `CMAP_STOPS` from matplotlib (16 stops per map).

## Sorting

Like Colorize, sorting is done in **pandas** (a `sort_values` in
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

## Filtering

Also done in **pandas**: `obj.query(expr, engine="python")` in `buildDumpCode`,
applied **before** sort and head (so the row count reflects the filtered total).
`engine="python"` is deliberate — it's the engine that supports string, datetime
and categorical comparisons plus column methods like `.isna()`/`.notna()`. The
expression uses bare column names (not `df.col`), which resolve identically for
files and kernel variables — that's why we don't use the variable name or `eval`.
Unlike sort's silent fallback, a bad expression is **surfaced**: the query runs in
its own `try/except`, the data is left unfiltered, and the pandas error string
rides back in the payload as `filterError` for the webview to show inline. Filter
is per-view like sort (rides on `ready`/`refresh`, not persisted).

## Column statistics

The stats section under the header is different from Colorize/sort/filter: it does
**not** trigger a reload. All per-column stats are computed in `buildDumpCode`
over the **full filtered `obj`** — before the `head(MAX_ROWS)` truncation, so
they stay exact on big tables — and ride along in the payload's `stats` field
(aligned index-first, like `columnTypes`). They're always shipped, so the
toggles are pure client-side show/hide, instant and free.

The section is a third sticky grid in the scroller (`#stats-row`, between
`#header` and `#body`), aligned to the column widths via `applyStatsLayout()`. It
holds two **sub-rows**, each a labelled grid row: missing counts (**Σ**,
`body.stats-missing`) and distributions (**graph** button, `body.stats-hist`).
Both sub-rows are always built; a toggle only flips its body
class, and CSS hides the inactive sub-row's cells (`display:none`) so the other
**reflows up** to the top of the grid — no rebuild on toggle. Each sub-row's
leftmost (sticky) cell labels it instead of showing the index's own value.

The histogram bins on a **"nice" rounded grid** (Heckbert): a step of the form
{1,2,5}×10ᵏ is picked near `range / HIST_BINS`, the low/high edges are snapped
down/up to multiples of it, and `np.histogram` runs on those edges — so every
edge is a readable round number on a shared grid (≈`HIST_BINS` bins, not exactly).
Edges are rounded to the step's precision in Python to shed float noise, and the
full `edges` array is shipped (the webview prints them verbatim via
`formatNumber`, which forces a locale-independent decimal point). The bars are
drawn by the pure `histogramSvg()` in `webview/stats.ts`: a `viewBox="0 0 bins
100"` SVG with `preserveAspectRatio="none"`, so it stretches to the cell and
**never rebuilds on resize**. Empty bins still get `HIST_MIN_BAR` so the spread
stays visible. Each bar is **tinted by its bin center** on the Colorize colormap
(`_bin_colors`, the center normalized over the data extent `[lo, hi]` — the same
mapping as the numeric cell coloring, so the histogram reads as a left-to-right
gradient and matches the cell colors); the per-bin `colors` array is applied in
`main.ts` via `rect.style.fill`, exactly like the categorical bars below. The
coloring **follows the Colorize type toggle**: a numeric histogram is tinted only
when `colorizeNumeric` is on, datetime/timedelta only when `colorizeDatetime` is
on — so turning Colorize off (which clears all the type flags) leaves the bars in
the default single fill, like the cells. `colors` is then `null` and the post-pass
that computes it (`_hgroup`/`_hranges`, see below) skips that histogram.

**Datetime/timedelta** share that histogram, with two twists. (1) Edges are
**calendar-/duration-aware**: `_date_edges` picks the finest `pd.date_range`
frequency (`YS`/`MS`/`D`/`h`/…) giving ≤ `HIST_BINS` bins and snaps the start to
that boundary; timedeltas use a nice-duration step (`_td_step`). (2) The payload
splits *position* from *label*: `edges`/`min`/`median`/`max` are numeric seconds
(epoch-seconds for dates, total-seconds for durations) so all the geometry
(`markerFraction`, ticks) is unchanged, while an optional `labels` object carries
the date/duration **strings** the webview shows instead of `formatNumber`.
Positions are normalized via `astype("datetime64[ns]")`/`timedelta64[ns]` first —
a bare `astype("int64")` is **not** nanoseconds for `[s]`/`[us]`-resolution
columns, which would silently mis-scale the counts against the ns-based edges.

The actual data **min/median/max** (rounded to 3 sig figs in Python, separate
from the grid edges) ride along too. Ticks are drawn in their own thin
**`tickStripSvg`** below the bars (a fixed-height strip, so the tick length is in
real pixels and doesn't scale with the bars) at `markerFraction(edges, value)` of
the width — since the axis spans the grid, not the data — with
`vector-effect="non-scaling-stroke"` to stay 1px. Their **labels** are plain HTML
in a `.hist-axis` row (min left, median center, max right), *not* SVG text, which
the non-uniform `preserveAspectRatio` would distort. min/max are straight ticks
(labels hug the edges); the median's label is centered, so its tick is an **elbow
path** (down half → across to x=50 → down) linking the exact position to the
centered label — most visible on skewed data.

**Ordered-categorical** columns get the other distribution shape (`_bars` in
`buildDumpCode`): `value_counts` reindexed to `dtype.categories` (category/rank
order, including zero-count categories), with each bar tinted by Colorize
colormap sampled at its rank — again only when the categorical toggle
(`colorizeCategorical`) is on, else `colors` is `null` and the bars stay a single
fill. They reuse `histogramSvg` for the bars; the
per-bar fill is applied in `main.ts` via `rect.style.fill` (DOM CSSOM, which is
CSP-safe and beats the stylesheet's default fill — an inline `style=` attribute
in the SVG string would be blocked by `style-src`). No ticks or min/median/max.
**Unordered discrete** columns — text/object, unordered categorical, bool —
get a horizontal stacked bar from `_nominal_info` in `buildDumpCode` (computed
once per column and reused for the cell coloring above, so bar and cells share
one palette). It walks `value_counts` (descending) a **count level** at a time —
a level is the set of values sharing a count — keeping a level's values as their
own bars only while the whole level fits the 9-color budget; the first level that
overflows (and everything rarer) collapses into "(other)", so equal-count ties
are never split arbitrarily. Colors are a **qualitative** palette (`tab10` minus
C7, the gray that would clash with the gray "(other)" bucket); `_nominal_info`
also returns the `vmap` (value→color) used for cell backgrounds; `unique` carries
the full distinct count (shown as a caption). `stackedBarSvg` lays the segments out
proportionally; fills are applied per-segment via `rect.style.fill`. Unlike the
histograms and ordinal bars, the stacked bar is **always colored** (its toggle
state is irrelevant) — a single-fill stacked bar is just one indistinguishable
block, so the palette is essential rather than decorative. Because the
segments have varying widths, hover hit-testing uses `segmentAt` (cumulative
count) rather than the uniform `binIndexAt`, and the bubble anchors above the
strip rather than a bar top.

The hover bubble reads `histogram?.counts ?? bars?.counts ?? segments?.counts`
and branches on which field is set, so one handler serves all three; the label
(bin range / category / value) is built with `textContent` since it's arbitrary
data. A column gets exactly one of `histogram` / `bars` / `segments` (numeric →
histogram, ordered categorical → bars, else → segments; datetime/timedelta get
none for now).

Per-bin details use a **custom hover bubble** (`#hist-bubble`), not the slow
native `title`. It's `position:fixed` on `<body>` (so the scroller/cell
`overflow` can't clip it) with `pointer-events:none`, and a delegated `mousemove`
on `#stats-row` derives the bin from the cursor's position over the SVG
(`binIndexAt`/`histogramBin`, both pure) — no per-bar hit targets needed. It's
centered over the bin and flips above/below the bar near the viewport top.

**Click to filter.** Each distribution ships a `filters` array parallel to its
`counts`: a ready-made pandas `query` clause per bin/value — `col >= lo & col <
hi` for histograms (last bin closed with `<=` to match `np.histogram`; numeric
edges for numeric, quoted date/duration label strings for datetime/timedelta),
`col == value` for bars and segments (`(other)` is null). They're built in Python
with the shared `_qcol`/`_lit`/`_rhs` helpers (the same ones the filter hint uses,
hoisted above `_nominal_info` so both can reach them), so column quoting and
datetime/timedelta/categorical literal formatting stay in one place. A delegated
`click` on `#stats-row` reuses the bubble's cursor→item math (`segmentAt` /
`binIndexAt`) to pick the clause, then opens the filter bar and applies it. The
click is scoped to `svg.hist`/`svg.stacked` via `closest()` so the labels and the
unique-count caption below the bars stay selectable (the bubble isn't scoped —
showing it over a label is harmless).

When adding a stat: extend `ColumnStat` and the Python `stats` list together, add
a sub-row in `buildStatsRow` (tagged with a `stat-*` class + a body toggle), and
keep any formatting/geometry in the pure `webview/stats.ts` so it's unit-tested.

## Webview specifics

- **Pure modules are the testable core.** Logic lives in DOM-free/vscode-free
  modules — `columns.ts`, `contrast.ts`, `colormaps.ts`, `dtypes.ts`,
  `tableHost.ts`, `colorizeSettings.ts` (which imports vscode as a **type only**) —
  so `node:test` can exercise them without a browser or editor. `webview/main.ts`
  is the DOM glue and is intentionally *not* unit-tested. When adding logic,
  extract the pure part.
- **Settings persistence:** Colorize choices live in `context.globalState`
  (`colorizeSettings.ts`, key `dataViewer.colorize`) so they carry across
  views/sessions. The toolbar **Colorize** button is a **derived select-all
  toggle** — active when any of the three colorize flags is on, and there is no
  separate `enabled` state to keep in sync.
- **Column widths** are an *estimate* (`CHAR_PX` px/char, with a bold-header
  factor); there's no text measurement. Manually-set widths are remembered by
  **column name** so they survive a refresh.
- **CSS cascade gotchas:** colormap colors are applied as inline `background-color`
  (so they override the zebra stripe), which also means hover doesn't recolor a
  colorized cell. And the row-hover rule must out-specify the
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

Debugger variables (`jupyterVariableViewer.ts`, `openDebugVariable`):

- The same `jupyterVariableViewers` command also fires from the **debugger's**
  variables pane ("View Value in Data Viewer"), distinguished by a `frameId` on
  the argument. There's no kernel, so we go over the **Debug Adapter Protocol**
  (`vscode.debug.activeDebugSession.customRequest(...)`) instead.
- DAP `evaluate` returns a value only for a single *expression* and doesn't hand
  back stdout, so the generated script is built with `outputFile` (writes its JSON
  to a temp file rather than `print`) and wrapped as one expression:
  `exec(base64-decoded-source, {**globals(), **locals()})`. base64 dodges all
  quoting; the merged namespace makes the target variable — a frame **local** —
  visible to the generated function (which sees it as a global). The host then
  reads and deletes the temp file.
- A `frameId` is only valid while paused at that frame, so each (re)load
  **re-resolves the thread's current top frame** via `stackTrace` (the thread is
  found once by scanning for the original `frameId`). Stepping/continuing keeps
  Refresh working; a terminated session surfaces a clear evaluate error.

File path (`pythonRunner.ts`):

- The interpreter is resolved from the Python extension's selected environment,
  falling back to `python3` on PATH. The chosen interpreter is logged to the
  "Data Viewer" output channel.
- A missing required package (pandas, or pyarrow/fastparquet for Parquet) raises
  `PythonEnvironmentError`, which the editor surfaces with a **"Select
  Interpreter"** retry loop. A CSV column can't carry an ordered categorical
  dtype (read_csv yields strings) — exercise that feature via a Jupyter variable
  (see `sample-data/jup-vars.py`).
- **Adding a file format** is small: register the extension in a `customEditors`
  selector in `package.json` (text formats CSV/TSV go in `dataViewer.table`,
  `priority: option`; binary formats Parquet/Feather go in `dataViewer.binary`,
  `priority: default` since binary has no text view — both contributions point at
  the one provider), and pick the read expression by extension in `loadData`
  (`csvReadExpression` / `parquetReadExpression` / `featherReadExpression` /
  `jsonLinesReadExpression`).
  Everything downstream is format-agnostic. A format that shouldn't default-open
  (e.g. the ambiguous `*.arrow`) goes in the `option` selector and the
  `explorer/context` menu's `when` clause instead, so it's reachable via
  right-click → Open in Data Viewer without claiming the file.
- **Compression** is mostly free: pandas infers it from the path, so the
  selectors just add brace-glob variants (`*.{csv,tsv}.{gz,bz2,zip,xz,zst,tar}`
  …), and `loadData` strips the compression suffix before the parquet-vs-csv
  check. The one catch: the CSV delimiter sniff must read the *decompressed*
  sample (via `pandas.io.common.get_handle`), since sniffing raw gzip bytes
  fails — with a `sep=None` pandas-sniff fallback.

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
