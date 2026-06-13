import * as vscode from 'vscode';
import { createTableHost, TableData } from './tableHost';

export { TableData } from './tableHost';

/**
 * Points a webview at the bundled table renderer and serves it rows in
 * chunks. Shared by the CSV custom editor and the Jupyter variable viewer.
 *
 * `load` re-reads the original data source (file or kernel variable); it runs
 * once when the webview is ready and again whenever the user clicks refresh.
 */
export function configureTableWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  load: () => Promise<TableData>
): vscode.Disposable {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
  webview.html = getHtml(webview, extensionUri);

  const handle = createTableHost({
    load,
    post: (message) => void webview.postMessage(message),
    reportError: (message) => void vscode.window.showErrorMessage(`Data Viewer: ${message}`),
  });

  return webview.onDidReceiveMessage(handle);
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
  <div id="toolbar">
    <button id="refresh" title="Reload data from its source"><span class="icon">↻</span></button>
  </div>
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
