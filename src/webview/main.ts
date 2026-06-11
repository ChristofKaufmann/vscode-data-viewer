import { CHUNK_SIZE, HostMessage, WebviewMessage } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();

const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 420;
const MAX_CACHED_CHUNKS = 64;

const scroller = document.getElementById('scroller')!;
const headerEl = document.getElementById('header')!;
const bodyEl = document.getElementById('body')!;
const statusEl = document.getElementById('status')!;

let columns: string[] = [];
let rowCount = 0;
let gridTemplate = '';
let numericCols: boolean[] = [];

const chunks = new Map<number, string[][]>();
const pendingChunks = new Set<number>();

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      columns = message.columns;
      rowCount = message.rowCount;
      initLayout(message.sample);
      // The sample only seeds the cache when it covers all of chunk 0;
      // a partial chunk would otherwise mask the missing rows forever.
      if (rowCount <= message.sample.length) {
        chunks.set(0, message.sample);
      }
      statusEl.textContent =
        rowCount === 0 && columns.length === 0
          ? 'Empty file'
          : `${rowCount.toLocaleString()} rows × ${columns.length.toLocaleString()} columns` +
            (message.note ? ` — ${message.note}` : '');
      render();
      break;
    case 'rows':
      pendingChunks.delete(message.chunk);
      chunks.set(message.chunk, message.rows);
      evictDistantChunks(message.chunk);
      render();
      break;
  }
});

let renderQueued = false;
scroller.addEventListener('scroll', () => {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }
});
window.addEventListener('resize', () => render());

function initLayout(sample: string[][]): void {
  const numberPattern = /^-?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/;
  const widths: number[] = [];
  numericCols = [];

  for (let c = 0; c < columns.length; c++) {
    let maxChars = columns[c].length;
    let numeric = true;
    let nonEmptySeen = false;
    for (const row of sample) {
      const value = row[c] ?? '';
      if (value.length > maxChars) {
        maxChars = value.length;
      }
      if (value !== '') {
        nonEmptySeen = true;
        if (!numberPattern.test(value.trim())) {
          numeric = false;
        }
      }
    }
    numericCols.push(nonEmptySeen && numeric);
    // ~8px per character plus cell padding; clamped to keep huge text columns usable.
    widths.push(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, maxChars * 8 + 18)));
  }

  const rowNumWidth = Math.max(46, String(rowCount).length * 8 + 22);
  gridTemplate = `${rowNumWidth}px ${widths.map((w) => `${w}px`).join(' ')}`;
  const totalWidth = rowNumWidth + widths.reduce((a, b) => a + b, 0);

  headerEl.style.gridTemplateColumns = gridTemplate;
  headerEl.style.width = `${totalWidth}px`;
  headerEl.replaceChildren();

  const corner = document.createElement('div');
  corner.className = 'cell rownum corner';
  headerEl.appendChild(corner);
  for (let c = 0; c < columns.length; c++) {
    const cell = document.createElement('div');
    cell.className = numericCols[c] ? 'cell head num' : 'cell head';
    cell.textContent = columns[c];
    cell.title = columns[c];
    headerEl.appendChild(cell);
  }

  bodyEl.style.height = `${rowCount * ROW_HEIGHT}px`;
  bodyEl.style.width = `${totalWidth}px`;
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
    const row = chunk?.[i - chunkIndex * CHUNK_SIZE];

    const rowEl = document.createElement('div');
    rowEl.className = i % 2 === 1 ? 'row alt' : 'row';
    rowEl.style.gridTemplateColumns = gridTemplate;
    rowEl.style.top = `${i * ROW_HEIGHT}px`;

    const numCell = document.createElement('div');
    numCell.className = 'cell rownum';
    numCell.textContent = String(i + 1);
    rowEl.appendChild(numCell);

    for (let c = 0; c < columns.length; c++) {
      const cell = document.createElement('div');
      cell.className = numericCols[c] ? 'cell num' : 'cell';
      cell.textContent = row ? (row[c] ?? '') : '…';
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
  }
}

vscode.postMessage({ type: 'ready' });
