// Messages exchanged between the extension host and the webview.
// Rows are transferred lazily in fixed-size chunks so large files
// never have to cross the message channel all at once.

export const CHUNK_SIZE = 500;

/** Webview -> extension host */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'rows'; chunk: number };

/** Extension host -> webview */
export type HostMessage =
  | {
      type: 'init';
      fileName: string;
      /** Optional extra status text, e.g. a truncation notice. */
      note?: string;
      columns: string[];
      rowCount: number;
      /** First rows, used for column width/type estimation and initial paint. */
      sample: string[][];
    }
  | { type: 'rows'; chunk: number; rows: string[][] };
