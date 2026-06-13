import { CHUNK_SIZE, HostMessage, WebviewMessage } from './shared/protocol';

export interface TableData {
  /** Label shown in the status bar (file or variable name). */
  fileName: string;
  /** Optional extra status text, e.g. a truncation notice. */
  note?: string;
  columns: string[];
  rows: string[][];
}

export interface TableHostDeps {
  /** Re-reads the original data source (file or kernel variable). */
  load: () => Promise<TableData>;
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

  const reload = async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      data = await deps.load();
      deps.post({
        type: 'init',
        fileName: data.fileName,
        note: data.note,
        columns: data.columns,
        rowCount: data.rows.length,
        sample: data.rows.slice(0, 100),
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
        void reload();
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
        });
        break;
      }
    }
  };
}
