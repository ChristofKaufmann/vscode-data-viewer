import * as vscode from 'vscode';
import { CHUNK_SIZE, HostMessage, WebviewMessage } from './shared/protocol';

export interface TableData {
  /** Label shown in the status bar (file or variable name). */
  fileName: string;
  /** Optional extra status text, e.g. a truncation notice. */
  note?: string;
  columns: string[];
  rows: string[][];
}

/**
 * Points a webview at the bundled table renderer and serves it rows in
 * chunks. Shared by the CSV custom editor and the Jupyter variable viewer.
 */
export function configureTableWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  data: TableData
): vscode.Disposable {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
  webview.html = getHtml(webview, extensionUri);

  return webview.onDidReceiveMessage((message: WebviewMessage) => {
    switch (message.type) {
      case 'ready':
        post(webview, {
          type: 'init',
          fileName: data.fileName,
          note: data.note,
          columns: data.columns,
          rowCount: data.rows.length,
          sample: data.rows.slice(0, 100),
        });
        break;
      case 'rows': {
        const start = message.chunk * CHUNK_SIZE;
        post(webview, {
          type: 'rows',
          chunk: message.chunk,
          rows: data.rows.slice(start, start + CHUNK_SIZE),
        });
        break;
      }
    }
  });
}

function post(webview: vscode.Webview, message: HostMessage): void {
  void webview.postMessage(message);
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Data Viewer</title>
</head>
<body>
  <div id="scroller">
    <div id="header"></div>
    <div id="body"></div>
  </div>
  <div id="status">Loading…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
