import * as vscode from 'vscode';
import Papa from 'papaparse';
import { configureTableWebview } from './tableWebview';

class TableDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly columns: string[],
    readonly rows: string[][]
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

  async openCustomDocument(uri: vscode.Uri): Promise<TableDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
    const data = result.data;
    // The first row is treated as the header.
    const columns = data.length > 0 ? data[0] : [];
    const rows = data.slice(1);
    return new TableDocument(uri, columns, rows);
  }

  resolveCustomEditor(document: TableDocument, webviewPanel: vscode.WebviewPanel): void {
    configureTableWebview(webviewPanel.webview, this.context.extensionUri, {
      fileName: document.uri.path.split('/').pop() ?? '',
      columns: document.columns,
      rows: document.rows,
    });
  }
}
