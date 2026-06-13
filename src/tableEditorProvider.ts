import * as vscode from 'vscode';
import { buildDumpCode, csvReadExpression, parsePayload, toTable } from './pandasTable';
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
  static readonly viewType = 'dataViewer.table';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TableEditorProvider.viewType,
      new TableEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
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
   * Reads the file via pandas.read_csv in the selected Python interpreter so
   * it behaves exactly like a DataFrame viewed from a kernel. If the
   * environment lacks pandas, offers to switch interpreter and retries.
   */
  private async loadData(uri: vscode.Uri, options: LoadOptions): Promise<TableData> {
    const name = uri.path.split('/').pop() ?? '';
    const code = buildDumpCode(
      csvReadExpression(uri.fsPath),
      options.colormap,
      options.center,
      options.columnwise
    );
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
          `${err.message} Select a Python interpreter with pandas installed to view this file.`,
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
