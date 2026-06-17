import {
  CHUNK_SIZE,
  ColumnStat,
  ColumnType,
  HostMessage,
  SortKey,
  WebviewMessage,
} from '../shared/protocol';
import { autoWidth, cellClass, clampDragWidth, isNumericColumn, maxChars } from './columns';
import { idealTextColor } from './contrast';
import { steppedGradient } from './colormaps';
import { dtypeGlyph } from './dtypes';
import { cycleSort, sortState } from './sorting';
import {
  barTopFraction,
  binIndexAt,
  formatNumber,
  formatPercent,
  histogramBin,
  histogramSvg,
  markerFraction,
  segmentAt,
  stackedBarSvg,
  tickStripSvg,
} from './stats';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();

const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const MAX_CACHED_CHUNKS = 64;

const scroller = document.getElementById('scroller')!;
const headerEl = document.getElementById('header')!;
const bodyEl = document.getElementById('body')!;
const statusEl = document.getElementById('status')!;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const colorizeToggle = document.getElementById('colorize-toggle') as HTMLButtonElement;
const settingsBtn = document.getElementById('colorize-settings') as HTMLButtonElement;
const colorizePanel = document.getElementById('colorize-panel')!;
const colormapSelect = document.getElementById('colormap') as HTMLSelectElement;
const colormapPreview = document.getElementById('colormap-preview')!;
const centerCheckbox = document.getElementById('center') as HTMLInputElement;
const columnwiseCheckbox = document.getElementById('columnwise') as HTMLInputElement;
const colorizeNumericCheckbox = document.getElementById('colorize-numeric') as HTMLInputElement;
const colorizeDatetimeCheckbox = document.getElementById('colorize-datetime') as HTMLInputElement;
const colorizeCategoricalCheckbox = document.getElementById('colorize-categorical') as HTMLInputElement;
const filterToggle = document.getElementById('filter-toggle') as HTMLButtonElement;
const filterInput = document.getElementById('filter-input') as HTMLInputElement;
const filterClear = document.getElementById('filter-clear') as HTMLButtonElement;
const filterError = document.getElementById('filter-error')!;
const statsToggle = document.getElementById('stats-toggle') as HTMLButtonElement;
const histToggle = document.getElementById('hist-toggle') as HTMLButtonElement;
const statsRow = document.getElementById('stats-row')!;

// Column 0 is always the DataFrame index (sticky on the left); columns 1..n
// are the data columns. Each row in a chunk follows the same layout.
let columns: string[] = [];
let rowCount = 0;
let gridTemplate = '';
let numericCols: boolean[] = [];
let colWidths: number[] = [];
let columnTypes: ColumnType[] | null = null;
// Per-column summary stats (index first), aligned to `columns`. Computed over
// the full filtered data, so counts are exact even when the view is truncated.
let columnStats: ColumnStat[] | null = null;
let rowTotal = 0;
// Multi-column sort, primary first; `column` is a 0-based data-column position
// (webview column index minus 1, since column 0 is the index). Per-view only.
let sortKeys: SortKey[] = [];
// pandas query expression; per-view (not persisted), applied on the host.
let currentFilter = '';

// Widths the user set explicitly (drag or auto-fit), keyed by column header so
// they survive a refresh even if columns are added/removed/reordered. Columns
// not in here keep auto-fitting to their content on each (re)load.
const manualWidths = new Map<string, number>();

const chunks = new Map<number, string[][]>();
// Cell colors per chunk, parallel to `chunks` (same keys/row layout). A
// chunk's entry is null when the table has no colormap colors at all.
const colorChunks = new Map<number, (string | null)[][] | null>();
const pendingChunks = new Set<number>();

let currentColormap = colormapSelect.value;
let currentCenter = centerCheckbox.checked;
let currentColumnwise = columnwiseCheckbox.checked;
let currentColorizeNumeric = colorizeNumericCheckbox.checked;
let currentColorizeDatetime = colorizeDatetimeCheckbox.checked;
let currentColorizeCategorical = colorizeCategoricalCheckbox.checked;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      // Drop any cached rows from the previous load — a refresh may have
      // changed the data underneath us.
      chunks.clear();
      colorChunks.clear();
      pendingChunks.clear();
      columns = message.columns;
      rowCount = message.rowCount;
      rowTotal = message.total;
      columnTypes = message.columnTypes;
      columnStats = message.stats;
      // The example query is built in pandas (real dtypes); we just wrap it.
      filterInput.placeholder = message.filterHint
        ? `Filter rows, e.g.  ${message.filterHint}`
        : 'Filter rows with a pandas query expression';
      initLayout(message.sample);
      buildStatsRow();
      // The sample only seeds the cache when it covers all of chunk 0;
      // a partial chunk would otherwise mask the missing rows forever.
      if (rowCount <= message.sample.length) {
        chunks.set(0, message.sample);
        colorChunks.set(0, message.sampleColors);
      }
      // columns[0] is the index, so the data column count is one less.
      const dataCols = Math.max(0, columns.length - 1);
      statusEl.textContent =
        rowCount === 0 && dataCols === 0
          ? 'Empty'
          : `${rowCount.toLocaleString()} rows × ${dataCols.toLocaleString()} columns` +
            (message.note ? ` — ${message.note}` : '');
      showFilterError(message.filterError);
      setRefreshing(false);
      render();
      break;
    }
    case 'rows':
      pendingChunks.delete(message.chunk);
      chunks.set(message.chunk, message.rows);
      colorChunks.set(message.chunk, message.colors);
      evictDistantChunks(message.chunk);
      render();
      break;
    case 'error':
      statusEl.textContent = `⚠ ${message.message}`;
      setRefreshing(false);
      break;
  }
});

refreshBtn.addEventListener('click', () => {
  if (!refreshBtn.disabled) {
    requestReload();
  }
});

/** Asks the host to re-read the source with the current Colorize settings. */
function requestReload(): void {
  setRefreshing(true);
  vscode.postMessage({
    type: 'refresh',
    colormap: currentColormap,
    center: currentCenter,
    columnwise: currentColumnwise,
    colorizeNumeric: currentColorizeNumeric,
    colorizeDatetime: currentColorizeDatetime,
    colorizeCategorical: currentColorizeCategorical,
    sort: sortKeys,
    filter: currentFilter,
  });
}

/** Toggles the refresh button's spinner/disabled state. */
function setRefreshing(on: boolean): void {
  refreshBtn.disabled = on;
  refreshBtn.classList.toggle('spinning', on);
}

// Persist Colorize choices so the next view inherits them.
function persistSettings(): void {
  vscode.postMessage({
    type: 'settings',
    colormap: currentColormap,
    center: currentCenter,
    columnwise: currentColumnwise,
    colorizeNumeric: currentColorizeNumeric,
    colorizeDatetime: currentColorizeDatetime,
    colorizeCategorical: currentColorizeCategorical,
  });
}

/** The master "Colorize" button is active when any column type is colorized. */
function syncMasterButton(): void {
  const any = currentColorizeNumeric || currentColorizeDatetime || currentColorizeCategorical;
  colorizeToggle.classList.toggle('active', any);
  colorizeToggle.setAttribute('aria-pressed', String(any));
}

/** A type toggle changed: update state, the master, persist, and reload. */
function onColorizeChanged(): void {
  currentColorizeNumeric = colorizeNumericCheckbox.checked;
  currentColorizeDatetime = colorizeDatetimeCheckbox.checked;
  currentColorizeCategorical = colorizeCategoricalCheckbox.checked;
  syncMasterButton();
  persistSettings();
  requestReload();
}
colorizeNumericCheckbox.addEventListener('change', onColorizeChanged);
colorizeDatetimeCheckbox.addEventListener('change', onColorizeChanged);
colorizeCategoricalCheckbox.addEventListener('change', onColorizeChanged);

// Master toggle: turn everything on if anything is off, else turn all off.
colorizeToggle.addEventListener('click', () => {
  const next = !(currentColorizeNumeric || currentColorizeDatetime || currentColorizeCategorical);
  currentColorizeNumeric = next;
  currentColorizeDatetime = next;
  currentColorizeCategorical = next;
  colorizeNumericCheckbox.checked = next;
  colorizeDatetimeCheckbox.checked = next;
  colorizeCategoricalCheckbox.checked = next;
  syncMasterButton();
  persistSettings();
  requestReload();
});
syncMasterButton();

/** Paints the preview swatch for the currently selected colormap. */
function updateColormapPreview(): void {
  colormapPreview.style.background = steppedGradient(currentColormap);
}
updateColormapPreview();

// Colormap and centering both recompute colors in Python, so they reload.
colormapSelect.addEventListener('change', () => {
  currentColormap = colormapSelect.value;
  updateColormapPreview();
  persistSettings();
  requestReload();
});

centerCheckbox.addEventListener('change', () => {
  currentCenter = centerCheckbox.checked;
  persistSettings();
  requestReload();
});

columnwiseCheckbox.addEventListener('change', () => {
  currentColumnwise = columnwiseCheckbox.checked;
  persistSettings();
  requestReload();
});

// Settings popover: toggle on the chevron, dismiss on outside-click or Escape.
function setPanelOpen(open: boolean): void {
  colorizePanel.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setPanelOpen(colorizePanel.hidden);
});
colorizePanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => setPanelOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setPanelOpen(false);
  }
});

// Filter bar: the funnel both reveals the bar and enables the filter. Hiding
// the bar disables the filter (data shown unfiltered) but keeps the expression
// in the input, so clicking the funnel again re-applies it.
filterToggle.addEventListener('click', () => {
  const open = !document.body.classList.contains('filtering');
  document.body.classList.toggle('filtering', open);
  filterToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    filterInput.focus();
  }
  syncFilter();
});

/**
 * Reconciles the applied filter with the UI: the input expression while the bar
 * is open, or none while it's hidden. Reloads only when it actually changed.
 */
function syncFilter(): void {
  const open = document.body.classList.contains('filtering');
  const next = open ? filterInput.value.trim() : '';
  if (next === currentFilter) {
    return;
  }
  currentFilter = next;
  filterToggle.classList.toggle('active', currentFilter !== '');
  requestReload();
}

filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    syncFilter();
  }
});
filterClear.addEventListener('click', () => {
  filterInput.value = '';
  syncFilter();
  filterInput.focus();
});

// Statistics rows: Σ toggles the missing-counts row, the graph button toggles
// the histogram row. Both ride along with every load, so toggling is purely a
// CSS show/hide (no reload). Hiding a sub-row's cells via display:none lets the
// other sub-row's cells reflow to the top of the grid, so no rebuild is needed.
function wireStatsToggle(btn: HTMLButtonElement, bodyClass: string): void {
  btn.addEventListener('click', () => {
    if (btn.disabled) {
      return;
    }
    const shown = !document.body.classList.contains(bodyClass);
    document.body.classList.toggle(bodyClass, shown);
    btn.classList.toggle('active', shown);
    btn.setAttribute('aria-pressed', String(shown));
  });
  // Both rows are shown by default; buildStatsRow() disables them if the source
  // produced no stats.
  document.body.classList.add(bodyClass);
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}
wireStatsToggle(statsToggle, 'stats-missing');
wireStatsToggle(histToggle, 'stats-hist');

/**
 * (Re)builds the stats section to match `columns`: a "missing" sub-row (counts)
 * and a "distribution" sub-row (numeric histograms), each a labelled grid row
 * aligned to the columns. Both are always built; the toggles show/hide them via
 * CSS. Disables the toggles when the source produced no stats.
 */
function buildStatsRow(): void {
  statsRow.replaceChildren();
  if (!columnStats) {
    for (const [btn, cls] of [
      [statsToggle, 'stats-missing'],
      [histToggle, 'stats-hist'],
    ] as const) {
      btn.disabled = true;
      document.body.classList.remove(cls);
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
    return;
  }
  statsToggle.disabled = false;
  histToggle.disabled = false;

  // Missing-counts sub-row.
  for (let c = 0; c < columns.length; c++) {
    const cell = document.createElement('div');
    if (c === 0) {
      cell.className = 'cell stat stat-missing indexcol';
      cell.textContent = 'missing';
      cell.title = 'Missing (NaN/NaT/None) values per column';
    } else {
      const missing = columnStats[c]?.missing ?? 0;
      cell.className = 'cell stat stat-missing';
      const pct = rowTotal > 0 ? formatPercent((missing / rowTotal) * 100) : '';
      cell.textContent = `${missing.toLocaleString()} (${pct})`;
      cell.title = `${missing.toLocaleString()} of ${rowTotal.toLocaleString()} missing${
        pct ? ` (${pct})` : ''
      }`;
    }
    statsRow.appendChild(cell);
  }

  // Distribution sub-row: numeric columns get a histogram, ordered categoricals
  // a colored bar-per-category, others blank.
  for (let c = 0; c < columns.length; c++) {
    const cell = document.createElement('div');
    if (c === 0) {
      cell.className = 'cell stat stat-hist indexcol';
      cell.textContent = 'distribution';
      cell.title = 'Value distribution (numeric and ordinal columns)';
    } else {
      cell.className = 'cell stat stat-hist';
      const hist = columnStats[c]?.histogram;
      const bars = columnStats[c]?.bars;
      const segments = columnStats[c]?.segments;
      if (segments && segments.counts.length) {
        // Unordered discrete column: a horizontal stacked bar + a unique-count
        // caption (which directly surfaces "how many distinct values").
        cell.classList.add('stat-nominal');
        cell.innerHTML = stackedBarSvg(segments.counts);
        if (segments.colors) {
          const rects = cell.querySelectorAll('rect');
          segments.colors.forEach((color, i) => {
            const rect = rects[i] as SVGElement | undefined;
            if (color && rect) {
              rect.style.fill = color;
            }
          });
        }
        const cap = document.createElement('div');
        cap.className = 'stacked-cap';
        cap.textContent = `${segments.allUnique ? 'all ' : ''}${segments.unique.toLocaleString()} unique`;
        cell.appendChild(cap);
        cell.dataset.col = String(c);
      } else if (bars && bars.counts.length) {
        cell.innerHTML = histogramSvg(bars.counts);
        // Tint each bar with its category's colormap color (DOM .style.fill is
        // CSP-safe and overrides the default fill from the stylesheet).
        if (bars.colors) {
          const rects = cell.querySelectorAll('rect');
          bars.colors.forEach((color, i) => {
            const rect = rects[i] as SVGElement | undefined;
            if (color && rect) {
              rect.style.fill = color;
            }
          });
        }
        cell.dataset.col = String(c);
      } else if (hist && hist.counts.length) {
        const f = (v: number) => markerFraction(hist.edges, v);
        cell.innerHTML =
          histogramSvg(hist.counts) + tickStripSvg(f(hist.min), f(hist.median), f(hist.max));
        // min / median / max labels below the chart (HTML, so they aren't
        // stretched by the SVG's non-uniform scaling): each a value over a
        // "(min)" / "(median)" / "(max)" caption, aligned left/center/right.
        const axis = document.createElement('div');
        axis.className = 'hist-axis';
        const labels: [number, string][] = [
          [hist.min, 'min'],
          [hist.median, 'median'],
          [hist.max, 'max'],
        ];
        for (const [v, name] of labels) {
          const item = document.createElement('div');
          item.className = 'ax';
          const val = document.createElement('span');
          val.className = 'ax-val';
          val.textContent = formatNumber(v);
          const cap = document.createElement('span');
          cap.className = 'ax-cap';
          cap.textContent = `(${name})`;
          item.append(val, cap);
          axis.appendChild(item);
        }
        cell.appendChild(axis);
        // Per-bin details come from a custom hover bubble (see below), not the
        // slow native title; data-col lets the delegated handler find the stats.
        cell.dataset.col = String(c);
      }
    }
    statsRow.appendChild(cell);
  }
  applyStatsLayout();
}

/** Aligns the stats row to the current column grid (called on layout changes). */
function applyStatsLayout(): void {
  statsRow.style.gridTemplateColumns = gridTemplate;
  statsRow.style.width = `${colWidths.reduce((a, b) => a + b, 0)}px`;
}

// Custom hover bubble for histogram bars: it shows immediately above the bin
// under the cursor (the native `title` is slow and OS-positioned). It's fixed
// and lives on <body> so the scroller/cell `overflow` can't clip it. The bin is
// derived from the cursor's position over the SVG, so it works across the gaps
// between bars without per-bar hit targets.
const histBubble = document.createElement('div');
histBubble.id = 'hist-bubble';
histBubble.style.transform = 'translateX(-50%)';
document.body.appendChild(histBubble);

function hideHistBubble(): void {
  histBubble.classList.remove('visible');
}

function showHistBubble(e: MouseEvent): void {
  const cell = (e.target as Element).closest('.cell.stat-hist') as HTMLElement | null;
  const col = cell?.dataset.col ? Number(cell.dataset.col) : -1;
  const stat = col >= 0 ? columnStats?.[col] : undefined;
  // One of: numeric histogram (label = bin range), categorical bars (label =
  // category), or a stacked bar (label = value). All expose a counts array.
  const counts = stat?.histogram?.counts ?? stat?.bars?.counts ?? stat?.segments?.counts;
  const svg = cell?.querySelector('svg');
  if (!stat || !counts || !counts.length || !svg) {
    hideHistBubble();
    return;
  }
  const rect = svg.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;

  // Resolve the hovered item, its label, the bubble's x-center fraction, and the
  // y it should sit above (the bar's top for vertical charts; the strip top for
  // the horizontal stacked bar).
  let label: string;
  let count: number;
  let centerFraction: number;
  let topY: number;
  if (stat.segments) {
    const { index, center } = segmentAt(counts, fx);
    label = stat.segments.labels[index] ?? '';
    count = counts[index];
    centerFraction = center;
    topY = rect.top;
  } else {
    const bin = binIndexAt(fx, counts.length);
    if (stat.histogram) {
      const { lo, hi } = histogramBin(stat.histogram, bin);
      label = `${formatNumber(lo)} – ${formatNumber(hi)}`;
    } else {
      label = stat.bars?.labels[bin] ?? '';
    }
    count = counts[bin];
    centerFraction = (bin + 0.5) / counts.length;
    topY = rect.top + barTopFraction(counts, bin) * rect.height;
  }

  const total = counts.reduce((a, b) => a + b, 0);
  const pct = total > 0 ? ` (${formatPercent((count / total) * 100)})` : '';
  // Build via textContent (not innerHTML) — category labels are arbitrary data.
  const rangeEl = document.createElement('div');
  rangeEl.className = 'hb-range';
  rangeEl.textContent = label;
  const countEl = document.createElement('div');
  countEl.className = 'hb-count';
  countEl.textContent = `${count.toLocaleString()}${pct}`;
  histBubble.replaceChildren(rangeEl, countEl);

  // Center over the item and sit above it, flipping below the chart if there
  // isn't room above (the stats row sits near the viewport top).
  histBubble.classList.add('visible');
  const { height } = histBubble.getBoundingClientRect();
  const x = rect.left + centerFraction * rect.width;
  const gap = 7;
  const above = topY - gap - height >= 2;
  histBubble.dataset.placement = above ? 'top' : 'bottom';
  histBubble.style.left = `${x}px`;
  histBubble.style.top = `${above ? topY - gap - height : rect.bottom + gap}px`;
}

statsRow.addEventListener('mousemove', showHistBubble);
statsRow.addEventListener('mouseleave', hideHistBubble);

/** Shows/clears the filter error from the last load (data shown unfiltered). */
function showFilterError(message: string | null): void {
  filterError.textContent = message ?? '';
  filterInput.classList.toggle('error', message !== null);
  if (message) {
    // Reveal the bar so the error is visible next to the input.
    document.body.classList.add('filtering');
    filterToggle.setAttribute('aria-expanded', 'true');
  }
}

let renderQueued = false;
function scheduleRender(): void {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }
}
scroller.addEventListener('scroll', scheduleRender);
window.addEventListener('resize', () => render());

function initLayout(sample: string[][]): void {
  colWidths = [];
  numericCols = [];

  for (let c = 0; c < columns.length; c++) {
    const values = sample.map((row) => row[c] ?? '');
    numericCols.push(isNumericColumn(values));
    const manual = manualWidths.get(columns[c]);
    colWidths.push(manual ?? autoWidth(maxChars(columns[c], values) + headerPad(c)));
  }

  buildHeader();
  applyLayout();
}

/**
 * Extra header-width allowance (in characters) for the chrome that sits beside
 * the name: the dtype glyph, and on data columns the sort handle (+ its
 * priority badge).
 */
function headerPad(c: number): number {
  const glyphPad = columnTypes?.[c] ? 2 : 0;
  // Every column (the index too) carries a sort handle.
  return glyphPad + 2;
}

/** (Re)builds the header row: type glyph + name + a sort control per column. */
function buildHeader(): void {
  headerEl.replaceChildren();
  for (let c = 0; c < columns.length; c++) {
    const cell = document.createElement('div');
    cell.className = classFor('cell head', c);

    // Left side: dimmed dtype glyph (full dtype as tooltip) + the column name.
    const label = document.createElement('span');
    label.className = 'head-label';
    const type = columnTypes?.[c];
    if (type) {
      const spec = dtypeGlyph(type.kind);
      const glyph = document.createElement('span');
      glyph.className = spec.codicon ? `dtype-glyph codicon codicon-${spec.codicon}` : 'dtype-glyph';
      if (spec.text) {
        glyph.textContent = spec.text;
      }
      glyph.title = type.dtype;
      label.appendChild(glyph);
    }
    label.appendChild(document.createTextNode(columns[c]));
    cell.appendChild(label);
    cell.title = columns[c];

    // Right side: sort control (every column, including the index).
    cell.appendChild(buildSortControl(c));

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.addEventListener('pointerdown', (e) => startResize(e, c));
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      autoFit(c);
    });
    cell.appendChild(handle);
    headerEl.appendChild(cell);
  }
}

/** The clickable sort handle for the column at webview index `c` (0 = index). */
function buildSortControl(c: number): HTMLElement {
  const dataColumn = c === 0 ? -1 : c - 1;
  const { dir, rank } = sortState(sortKeys, dataColumn);
  const icon = dir === 'asc' ? 'arrow-down' : dir === 'desc' ? 'arrow-up' : 'circle-small-filled';

  const btn = document.createElement('span');
  btn.className = dir === 'none' ? 'sort-btn inactive' : 'sort-btn';
  btn.title =
    dir === 'none' ? 'Sort ascending' : dir === 'asc' ? 'Sort descending' : 'Remove from sort';

  const glyph = document.createElement('span');
  glyph.className = `codicon codicon-${icon}`;
  btn.appendChild(glyph);

  // Show the 1-based priority only when more than one column is sorted.
  if (rank > 0 && sortKeys.length > 1) {
    const badge = document.createElement('span');
    badge.className = 'sort-rank';
    badge.textContent = String(rank);
    btn.appendChild(badge);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    sortKeys = cycleSort(sortKeys, dataColumn);
    buildHeader(); // instant feedback while the sorted data reloads
    requestReload();
  });
  return btn;
}

function classFor(base: string, col: number): string {
  return cellClass(base, { index: col === 0, numeric: numericCols[col] });
}

function applyLayout(): void {
  gridTemplate = colWidths.map((w) => `${w}px`).join(' ');
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  headerEl.style.gridTemplateColumns = gridTemplate;
  headerEl.style.width = `${totalWidth}px`;
  bodyEl.style.width = `${totalWidth}px`;
  bodyEl.style.height = `${rowCount * ROW_HEIGHT}px`;
  applyStatsLayout();
}

function startResize(event: PointerEvent, col: number): void {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.target as HTMLElement;
  const startX = event.clientX;
  const startWidth = colWidths[col];
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('active');
  document.body.classList.add('resizing');

  const onMove = (e: PointerEvent) => {
    colWidths[col] = clampDragWidth(startWidth + (e.clientX - startX));
    applyLayout();
    scheduleRender();
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.classList.remove('active');
    document.body.classList.remove('resizing');
    manualWidths.set(columns[col], colWidths[col]);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

/** Double-click on a handle: fit the column to its header and cached rows. */
function autoFit(col: number): void {
  const values: string[] = [];
  for (const rows of chunks.values()) {
    for (const row of rows) {
      values.push(row[col] ?? '');
    }
  }
  colWidths[col] = autoWidth(maxChars(columns[col], values) + headerPad(col));
  manualWidths.set(columns[col], colWidths[col]);
  applyLayout();
  render();
}

function render(): void {
  if (columns.length === 0) {
    return;
  }
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rowCount,
    Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_HEIGHT) + OVERSCAN
  );

  const fragment = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunk = chunks.get(chunkIndex);
    if (!chunk) {
      requestChunk(chunkIndex);
    }
    const localRow = i - chunkIndex * CHUNK_SIZE;
    const row = chunk?.[localRow];
    // Colors already reflect the enabled column types (computed in Python), so
    // we just paint whatever arrives.
    const colorRow = (colorChunks.get(chunkIndex) ?? null)?.[localRow];

    const rowEl = document.createElement('div');
    rowEl.className = i % 2 === 1 ? 'row alt' : 'row';
    rowEl.style.gridTemplateColumns = gridTemplate;
    rowEl.style.top = `${i * ROW_HEIGHT}px`;

    for (let c = 0; c < columns.length; c++) {
      const cell = document.createElement('div');
      cell.className = classFor('cell', c);
      cell.textContent = row ? (row[c] ?? '') : '…';
      const bg = colorRow?.[c];
      if (bg) {
        cell.style.backgroundColor = bg;
        cell.style.color = idealTextColor(bg);
      }
      rowEl.appendChild(cell);
    }
    fragment.appendChild(rowEl);
  }
  bodyEl.replaceChildren(fragment);
}

function requestChunk(chunkIndex: number): void {
  if (pendingChunks.has(chunkIndex)) {
    return;
  }
  pendingChunks.add(chunkIndex);
  vscode.postMessage({ type: 'rows', chunk: chunkIndex });
}

function evictDistantChunks(currentChunk: number): void {
  if (chunks.size <= MAX_CACHED_CHUNKS) {
    return;
  }
  const sorted = [...chunks.keys()].sort(
    (a, b) => Math.abs(b - currentChunk) - Math.abs(a - currentChunk)
  );
  for (const key of sorted.slice(0, chunks.size - MAX_CACHED_CHUNKS)) {
    chunks.delete(key);
    colorChunks.delete(key);
  }
}

setRefreshing(true);
vscode.postMessage({
  type: 'ready',
  colormap: currentColormap,
  center: currentCenter,
  columnwise: currentColumnwise,
  colorizeNumeric: currentColorizeNumeric,
  colorizeDatetime: currentColorizeDatetime,
  colorizeCategorical: currentColorizeCategorical,
  sort: sortKeys,
  filter: currentFilter,
});
