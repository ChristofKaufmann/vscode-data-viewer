import * as vscode from 'vscode';
import {
  buildDumpCode,
  csvReadExpression,
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
  // CSV/TSV (opt-in) and Parquet (default) share one provider; the reader is
  // chosen per file by extension.
  static readonly viewType = 'dataViewer.table';
  static readonly parquetViewType = 'dataViewer.parquet';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new TableEditorProvider(context);
    const options = {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    };
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(TableEditorProvider.viewType, provider, options),
      vscode.window.registerCustomEditorProvider(
        TableEditorProvider.parquetViewType,
        provider,
        options
      )
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
    const isParquet = /\.(parquet|pq)$/i.test(base);
    const readExpr = isParquet ? parquetReadExpression(uri.fsPath) : csvReadExpression(uri.fsPath);
    const code = buildDumpCode(readExpr, options);
    for (;;) {
      try {
        const stdout = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Data Viewer: loading ${name}…` },
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
