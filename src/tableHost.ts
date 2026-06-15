import { CHUNK_SIZE, ColumnType, HostMessage, SortKey, WebviewMessage } from './shared/protocol';

export interface TableData {
  /** Label shown in the status bar (file or variable name). */
  fileName: string;
  /** Optional extra status text, e.g. a truncation notice. */
  note?: string;
  columns: string[];
  rows: string[][];
  /** Per-cell heatmap colors aligned to `rows`, or null when none apply. */
  colors: (string | null)[][] | null;
  /** Per-column dtype info aligned to `columns` (index first), or null. */
  columnTypes: ColumnType[] | null;
  /** pandas error from a failed filter query (data shown unfiltered), or null. */
  filterError: string | null;
}

/** Parameters that affect how the data is (re)loaded, set from the webview UI. */
export interface LoadOptions {
  /** matplotlib colormap name for the heatmap; undefined uses the default. */
  colormap?: string;
  /** Center the heatmap value range on 0 (symmetric vmin/vmax). */
  center?: boolean;
  /** Compute the value range per column instead of per type group. */
  columnwise?: boolean;
  /** Color numeric columns. */
  colorizeNumeric?: boolean;
  /** Color datetime/timedelta columns. */
  colorizeDatetime?: boolean;
  /** Color ordered categorical columns by rank. */
  colorizeCategorical?: boolean;
  /** Multi-column sort keys (primary first); empty/undefined = unsorted. */
  sort?: SortKey[];
  /** pandas query filter expression; empty/undefined = unfiltered. */
  filter?: string;
}

export interface TableHostDeps {
  /** Re-reads the original data source (file or kernel variable). */
  load: (options: LoadOptions) => Promise<TableData>;
  /** Sends a message to the webview. */
  post: (message: HostMessage) => void;
  /** Surfaces a load failure to the user (e.g. a notification). */
  reportError: (message: string) => void;
}

/**
 * The webview message loop, free of any vscode dependency so it can be unit
 * tested. (Re)loads data on `ready`/`refresh` and serves row chunks. A reload
 * already in flight swallows further requests so overlapping loads can't race.
 */
export function createTableHost(deps: TableHostDeps): (message: WebviewMessage) => void {
  let data: TableData | undefined;
  let busy = false;

  const reload = async (options: LoadOptions): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      data = await deps.load(options);
      deps.post({
        type: 'init',
        fileName: data.fileName,
        note: data.note,
        columns: data.columns,
        rowCount: data.rows.length,
        sample: data.rows.slice(0, 100),
        sampleColors: data.colors ? data.colors.slice(0, 100) : null,
        columnTypes: data.columnTypes,
        filterError: data.filterError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.reportError(message);
      deps.post({ type: 'error', message });
    } finally {
      busy = false;
    }
  };

  return (message: WebviewMessage) => {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        void reload({
          colormap: message.colormap,
          center: message.center,
          columnwise: message.columnwise,
          colorizeNumeric: message.colorizeNumeric,
          colorizeDatetime: message.colorizeDatetime,
          colorizeCategorical: message.colorizeCategorical,
          sort: message.sort,
          filter: message.filter,
        });
        break;
      case 'rows': {
        if (!data) {
          return;
        }
        const start = message.chunk * CHUNK_SIZE;
        deps.post({
          type: 'rows',
          chunk: message.chunk,
          rows: data.rows.slice(start, start + CHUNK_SIZE),
          colors: data.colors ? data.colors.slice(start, start + CHUNK_SIZE) : null,
        });
        break;
      }
    }
  };
}
