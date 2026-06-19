import * as vscode from 'vscode';
import { getColorizeSettings, ColorizeSettings, updateColorizeSettings } from './colorizeSettings';
import { createTableHost, LoadOptions, TableData } from './tableHost';
import { WebviewMessage } from './shared/protocol';

export { LoadOptions, TableData } from './tableHost';

// Colormaps offered in the Colorize settings popover: matplotlib's full named
// set, grouped by its standard categories. The preview swatches in
// `webview/colormaps.ts` (CMAP_STOPS) must stay in sync with these names —
// regenerate both from matplotlib together if this list changes.
const COLORMAP_GROUPS: { label: string; names: string[] }[] = [
  { label: 'Perceptually uniform', names: ['viridis', 'plasma', 'inferno', 'magma', 'cividis'] },
  { label: 'Sequential', names: ['Greys', 'Purples', 'Blues', 'Greens', 'Oranges', 'Reds', 'YlOrBr', 'YlOrRd', 'OrRd', 'PuRd', 'RdPu', 'BuPu', 'GnBu', 'PuBu', 'YlGnBu', 'PuBuGn', 'BuGn', 'YlGn'] },
  { label: 'Sequential (2)', names: ['binary', 'gist_yarg', 'gist_gray', 'gray', 'bone', 'pink', 'spring', 'summer', 'autumn', 'winter', 'cool', 'Wistia', 'hot', 'afmhot', 'gist_heat', 'copper'] },
  { label: 'Diverging', names: ['PiYG', 'PRGn', 'BrBG', 'PuOr', 'RdGy', 'RdBu', 'RdYlBu', 'RdYlGn', 'Spectral', 'coolwarm', 'bwr', 'seismic', 'berlin', 'managua', 'vanimo'] },
  { label: 'Cyclic', names: ['twilight', 'twilight_shifted', 'hsv'] },
  { label: 'Miscellaneous', names: ['ocean', 'gist_earth', 'terrain', 'gist_stern', 'gnuplot', 'gnuplot2', 'CMRmap', 'cubehelix', 'brg', 'gist_rainbow', 'rainbow', 'jet', 'turbo', 'nipy_spectral', 'gist_ncar'] },
];

/**
 * Points a webview at the bundled table renderer and serves it rows in
 * chunks. Shared by the CSV custom editor and the Jupyter variable viewer.
 *
 * `load` re-reads the original data source (file or kernel variable); it runs
 * once when the webview is ready and again whenever the user clicks refresh.
 * Colorize UI choices are seeded from (and saved back to) the extension's
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
  webview.html = getHtml(webview, context.extensionUri, getColorizeSettings(context));

  const handle = createTableHost({
    load,
    post: (message) => void webview.postMessage(message),
    reportError: (message) => void vscode.window.showErrorMessage(`Data Viewer: ${message}`),
  });

  return webview.onDidReceiveMessage((message: WebviewMessage) => {
    if (message.type === 'settings') {
      void updateColorizeSettings(context, {
        colorizeNumeric: message.colorizeNumeric,
        colorizeDatetime: message.colorizeDatetime,
        colorizeCategorical: message.colorizeCategorical,
        colorizeText: message.colorizeText,
        colormap: message.colormap,
        center: message.center,
        columnwise: message.columnwise,
        showMissing: message.showMissing,
        showGraphs: message.showGraphs,
      });
      return;
    }
    handle(message);
  });
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  settings: ColorizeSettings
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'codicons', 'codicon.css')
  );
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

  // The Colorize toggle is "active" when any column type is colorized.
  const anyColorize =
    settings.colorizeNumeric ||
    settings.colorizeDatetime ||
    settings.colorizeCategorical ||
    settings.colorizeText;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
  <title>Data Viewer</title>
</head>
<body>
  <div id="toolbar">
    <button id="refresh" class="tbtn" title="Reload data from its source"><span class="icon">↻</span><span>Refresh</span></button>
    <button id="filter-toggle" class="tbtn" title="Filter rows" aria-expanded="false"><span class="codicon codicon-filter"></span><span>Filter</span></button>
    <button id="stats-toggle" class="tbtn${settings.showMissing ? ' active' : ''}" title="Show missing-value counts" aria-pressed="${settings.showMissing}"><span class="icon">Σ</span><span>Missing</span></button>
    <button id="hist-toggle" class="tbtn${settings.showGraphs ? ' active' : ''}" title="Show value distributions" aria-pressed="${settings.showGraphs}"><span class="codicon codicon-graph"></span><span>Graphs</span></button>
    <div id="colorize-menu">
      <button id="colorize-toggle" class="tbtn${anyColorize ? ' active' : ''}" title="Color cells by value" aria-pressed="${anyColorize}"><span class="codicon codicon-symbol-color"></span><span>Colorize</span></button>
      <button id="colorize-settings" title="Colorize settings" aria-expanded="false" aria-haspopup="true"><span class="codicon codicon-chevron-down"></span></button>
      <div id="colorize-panel" role="dialog" aria-label="Colorize settings" hidden>
        <label class="field-check" title="Color numeric columns">
          <input type="checkbox" id="colorize-numeric"${settings.colorizeNumeric ? ' checked' : ''}> Colorize numeric
        </label>
        <label class="field-check" title="Color datetime columns by their timestamp">
          <input type="checkbox" id="colorize-datetime"${settings.colorizeDatetime ? ' checked' : ''}> Colorize datetime
        </label>
        <label class="field-check" title="Color ordered categorical columns by rank">
          <input type="checkbox" id="colorize-categorical"${settings.colorizeCategorical ? ' checked' : ''}> Colorize categorical
        </label>
        <label class="field-check" title="Color text / unordered / boolean cells by value, matching the distribution bar">
          <input type="checkbox" id="colorize-text"${settings.colorizeText ? ' checked' : ''}> Colorize text
        </label>
        <label class="field">
          <span>Colormap</span>
          <div class="colormap-row">
            <select id="colormap">${colormapOptions}</select>
            <span id="colormap-preview" aria-hidden="true"></span>
          </div>
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
  <div id="filter-bar">
    <input type="text" id="filter-input" spellcheck="false" autocomplete="off"
           placeholder="Filter rows with a pandas query expression">
    <button id="filter-clear" title="Clear filter"><span class="codicon codicon-close"></span></button>
    <span id="filter-error"></span>
  </div>
  <div id="scroller">
    <div id="header"></div>
    <div id="stats-row"></div>
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
