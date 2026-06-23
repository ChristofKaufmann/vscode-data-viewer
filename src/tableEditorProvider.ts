import * as vscode from 'vscode';
import {
  buildDumpCode,
  csvReadExpression,
  featherReadExpression,
  jsonLinesReadExpression,
  numpyReadExpression,
  parquetReadExpression,
  parsePayload,
  toTable,
} from './pandasTable';
import {
  canSelectInterpreter,
  PythonEnvironmentError,
  runPythonScript,
  selectInterpreter,
} from './pythonRunner';
import { configureTableWebview, LoadOptions, TableData } from './tableWebview';

class TableDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {}
}

export class TableEditorProvider implements vscode.CustomReadonlyEditorProvider<TableDocument> {
  // All formats (CSV/TSV, Parquet/Feather, NumPy, …) are opt-in: the editor has
  // `priority: option`, so it's reached via "Open in DataFrame Viewer" / "Reopen Editor
  // With…" rather than replacing the default. The reader is chosen per file by
  // extension in loadData.
  static readonly viewType = 'dataViewer.table';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new TableEditorProvider(context);
    const options = {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    };
    return vscode.window.registerCustomEditorProvider(
      TableEditorProvider.viewType,
      provider,
      options
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): TableDocument {
    return new TableDocument(uri);
  }

  resolveCustomEditor(document: TableDocument, webviewPanel: vscode.WebviewPanel): void {
    configureTableWebview(webviewPanel.webview, this.context, (options) =>
      this.loadData(document.uri, options)
    );
  }

  /**
   * Reads the file (pd.read_csv or pd.read_parquet, by extension) in the
   * selected Python interpreter so it behaves exactly like a DataFrame viewed
   * from a kernel. If the environment is missing a required package, offers to
   * switch interpreter and retries.
   */
  private async loadData(uri: vscode.Uri, options: LoadOptions): Promise<TableData> {
    const name = uri.path.split('/').pop() ?? '';
    // Strip a trailing compression extension before checking the data format
    // (pandas infers the compression itself), e.g. "data.parquet.gz".
    const base = uri.path.replace(/\.(tar\.gz|tar\.xz|tar\.bz2|gz|bz2|zip|xz|zst|tar)$/i, '');
    const readExpr = /\.(parquet|pq)$/i.test(base)
      ? parquetReadExpression(uri.fsPath)
      : /\.(feather|arrow)$/i.test(base)
        ? featherReadExpression(uri.fsPath)
        : /\.(npy|npz)$/i.test(base)
          ? numpyReadExpression(uri.fsPath)
          : /\.(jsonl|ndjson)$/i.test(base)
            ? jsonLinesReadExpression(uri.fsPath)
            : csvReadExpression(uri.fsPath);
    const code = buildDumpCode(readExpr, options);
    for (;;) {
      try {
        const stdout = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `DataFrame Viewer: loading ${name}…` },
          (_progress, token) => runPythonScript(code, uri, token)
        );
        return { fileName: name, ...toTable(parsePayload(stdout)) };
      } catch (err) {
        if (!(err instanceof PythonEnvironmentError) || !canSelectInterpreter()) {
          throw err;
        }
        const choice = await vscode.window.showErrorMessage(
          `${err.message} You can pick a different interpreter via Select Interpreter.`,
          'Select Interpreter'
        );
        if (choice !== 'Select Interpreter') {
          throw err;
        }
        await selectInterpreter();
      }
    }
  }
}
