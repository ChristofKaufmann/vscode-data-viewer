import * as vscode from 'vscode';
import { buildDumpCode, csvReadExpression, parsePayload, toTable } from './pandasTable';
import {
  canSelectInterpreter,
  PythonEnvironmentError,
  runPythonScript,
  selectInterpreter,
} from './pythonRunner';
import { configureTableWebview } from './tableWebview';

class TableDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly columns: string[],
    readonly rows: string[][],
    readonly note?: string
  ) {}

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

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<TableDocument> {
    // Files go through pandas.read_csv in the selected Python interpreter, so
    // they behave exactly like DataFrames viewed from a Jupyter kernel.
    const code = buildDumpCode(csvReadExpression(uri.fsPath));
    for (;;) {
      try {
        const stdout = await runPythonScript(code, uri, token);
        const { columns, rows, note } = toTable(parsePayload(stdout));
        return new TableDocument(uri, columns, rows, note);
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

  resolveCustomEditor(document: TableDocument, webviewPanel: vscode.WebviewPanel): void {
    configureTableWebview(webviewPanel.webview, this.context.extensionUri, {
      fileName: document.uri.path.split('/').pop() ?? '',
      note: document.note,
      columns: document.columns,
      rows: document.rows,
    });
  }
}
