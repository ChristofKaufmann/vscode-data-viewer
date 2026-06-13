import * as vscode from 'vscode';
import { getHeatmapSettings, HeatmapSettings, updateHeatmapSettings } from './heatmapSettings';
import { createTableHost, LoadOptions, TableData } from './tableHost';
import { WebviewMessage } from './shared/protocol';

export { LoadOptions, TableData } from './tableHost';

// Colormaps offered in the heatmap settings popover (matplotlib names).
const COLORMAP_GROUPS: { label: string; names: string[] }[] = [
  { label: 'Perceptually uniform', names: ['viridis', 'plasma', 'inferno', 'magma', 'cividis'] },
  { label: 'Sequential', names: ['Blues', 'Greens', 'Oranges', 'Greys'] },
  { label: 'Diverging', names: ['coolwarm', 'RdBu', 'Spectral', 'bwr'] },
];

/**
 * Points a webview at the bundled table renderer and serves it rows in
 * chunks. Shared by the CSV custom editor and the Jupyter variable viewer.
 *
 * `load` re-reads the original data source (file or kernel variable); it runs
 * once when the webview is ready and again whenever the user clicks refresh.
 * Heatmap UI choices are seeded from (and saved back to) the extension's
 * global state so they persist across views.
 */
export function configureTableWebview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  load: (options: LoadOptions) => Promise<TableData>
): vscode.Disposable {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'dist'),
      vscode.Uri.joinPath(context.extensionUri, 'media'),
    ],
  };
  webview.html = getHtml(webview, context.extensionUri, getHeatmapSettings(context));

  const handle = createTableHost({
    load,
    post: (message) => void webview.postMessage(message),
    reportError: (message) => void vscode.window.showErrorMessage(`Data Viewer: ${message}`),
  });

  return webview.onDidReceiveMessage((message: WebviewMessage) => {
    if (message.type === 'settings') {
      void updateHeatmapSettings(context, {
        enabled: message.enabled,
        colormap: message.colormap,
        center: message.center,
        columnwise: message.columnwise,
      });
      return;
    }
    handle(message);
  });
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  settings: HeatmapSettings
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const nonce = getNonce();

  const colormapOptions = COLORMAP_GROUPS.map(
    (group) =>
      `<optgroup label="${group.label}">` +
      group.names
        .map(
          (name) =>
            `<option value="${name}"${name === settings.colormap ? ' selected' : ''}>${name}</option>`
        )
        .join('') +
      `</optgroup>`
  ).join('');

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
    <label id="heatmap-toggle" title="Color numeric cells by value">
      <input type="checkbox" id="heatmap"${settings.enabled ? ' checked' : ''}> Heatmap
    </label>
    <div id="heatmap-menu">
      <button id="heatmap-settings" title="Heatmap settings" aria-expanded="false" aria-haspopup="true">⚙</button>
      <div id="heatmap-panel" role="dialog" aria-label="Heatmap settings" hidden>
        <label class="field">
          <span>Colormap</span>
          <select id="colormap">${colormapOptions}</select>
        </label>
        <label class="field-check" title="Make the value range symmetric around 0">
          <input type="checkbox" id="center"${settings.center ? ' checked' : ''}> Center at 0
        </label>
        <label class="field-check" title="Use a separate value range per column">
          <input type="checkbox" id="columnwise"${settings.columnwise ? ' checked' : ''}> Columnwise
        </label>
      </div>
    </div>
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
