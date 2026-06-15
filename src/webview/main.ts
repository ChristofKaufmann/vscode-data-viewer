import { CHUNK_SIZE, ColumnType, HostMessage, SortKey, WebviewMessage } from '../shared/protocol';
import { autoWidth, cellClass, clampDragWidth, isNumericColumn, maxChars } from './columns';
import { idealTextColor } from './contrast';
import { steppedGradient } from './colormaps';
import { dtypeGlyph } from './dtypes';
import { cycleSort, sortState } from './sorting';

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
const heatmapCheckbox = document.getElementById('heatmap') as HTMLInputElement;
const settingsBtn = document.getElementById('heatmap-settings') as HTMLButtonElement;
const heatmapPanel = document.getElementById('heatmap-panel')!;
const colormapSelect = document.getElementById('colormap') as HTMLSelectElement;
const colormapPreview = document.getElementById('colormap-preview')!;
const centerCheckbox = document.getElementById('center') as HTMLInputElement;
const columnwiseCheckbox = document.getElementById('columnwise') as HTMLInputElement;
const colorizeNumericCheckbox = document.getElementById('colorize-numeric') as HTMLInputElement;
const colorizeDatetimeCheckbox = document.getElementById('colorize-datetime') as HTMLInputElement;
const colorizeCategoricalCheckbox = document.getElementById('colorize-categorical') as HTMLInputElement;

// Column 0 is always the DataFrame index (sticky on the left); columns 1..n
// are the data columns. Each row in a chunk follows the same layout.
let columns: string[] = [];
let rowCount = 0;
let gridTemplate = '';
let numericCols: boolean[] = [];
let colWidths: number[] = [];
let columnTypes: ColumnType[] | null = null;
// Multi-column sort, primary first; `column` is a 0-based data-column position
// (webview column index minus 1, since column 0 is the index). Per-view only.
let sortKeys: SortKey[] = [];

// Widths the user set explicitly (drag or auto-fit), keyed by column header so
// they survive a refresh even if columns are added/removed/reordered. Columns
// not in here keep auto-fitting to their content on each (re)load.
const manualWidths = new Map<string, number>();

const chunks = new Map<number, string[][]>();
// Heatmap colors per chunk, parallel to `chunks` (same keys/row layout). A
// chunk's entry is null when the table has no heatmap colors at all.
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
      columnTypes = message.columnTypes;
      initLayout(message.sample);
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

/** Asks the host to re-read the source with the current heatmap settings. */
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
  });
}

/** Toggles the refresh button's spinner/disabled state. */
function setRefreshing(on: boolean): void {
  refreshBtn.disabled = on;
  refreshBtn.classList.toggle('spinning', on);
}

// Persist heatmap choices so the next view inherits them.
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

/** The master "Heatmap" checkbox mirrors the type toggles (select-all). */
function syncMasterCheckbox(): void {
  const all = currentColorizeNumeric && currentColorizeDatetime && currentColorizeCategorical;
  const none = !currentColorizeNumeric && !currentColorizeDatetime && !currentColorizeCategorical;
  heatmapCheckbox.checked = all;
  heatmapCheckbox.indeterminate = !all && !none;
}

/** A type toggle changed: update state, the master, persist, and reload. */
function onColorizeChanged(): void {
  currentColorizeNumeric = colorizeNumericCheckbox.checked;
  currentColorizeDatetime = colorizeDatetimeCheckbox.checked;
  currentColorizeCategorical = colorizeCategoricalCheckbox.checked;
  syncMasterCheckbox();
  persistSettings();
  requestReload();
}
colorizeNumericCheckbox.addEventListener('change', onColorizeChanged);
colorizeDatetimeCheckbox.addEventListener('change', onColorizeChanged);
colorizeCategoricalCheckbox.addEventListener('change', onColorizeChanged);

// Master toggle: turn everything on if anything is off, else turn all off.
heatmapCheckbox.addEventListener('change', () => {
  const next = !(currentColorizeNumeric || currentColorizeDatetime || currentColorizeCategorical);
  currentColorizeNumeric = next;
  currentColorizeDatetime = next;
  currentColorizeCategorical = next;
  colorizeNumericCheckbox.checked = next;
  colorizeDatetimeCheckbox.checked = next;
  colorizeCategoricalCheckbox.checked = next;
  syncMasterCheckbox();
  persistSettings();
  requestReload();
});
syncMasterCheckbox();

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

// Settings popover: toggle on the gear, dismiss on outside-click or Escape.
function setPanelOpen(open: boolean): void {
  heatmapPanel.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setPanelOpen(heatmapPanel.hidden);
});
heatmapPanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => setPanelOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setPanelOpen(false);
  }
});

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
    // The dtype glyph on a header needs ~2 extra characters of room.
    const glyphPad = columnTypes?.[c] ? 2 : 0;
    const manual = manualWidths.get(columns[c]);
    colWidths.push(manual ?? autoWidth(maxChars(columns[c], values) + glyphPad));
  }

  buildHeader();
  applyLayout();
}

/** (Re)builds the header row: type glyph + name + (data columns) sort control. */
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

    // Right side: sort control on data columns (the index isn't sortable yet).
    if (c >= 1) {
      cell.appendChild(buildSortControl(c));
    }

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

/** The clickable sort handle for the data column at webview index `c`. */
function buildSortControl(c: number): HTMLElement {
  const dataColumn = c - 1;
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
  colWidths[col] = autoWidth(maxChars(columns[col], values));
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
});
