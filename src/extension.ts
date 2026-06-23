import * as vscode from 'vscode';
import { TableEditorProvider } from './tableEditorProvider';
import { registerJupyterVariableViewer } from './jupyterVariableViewer';
import { registerColorizeSettingsSync } from './colorizeSettings';

export function activate(context: vscode.ExtensionContext): void {
  registerColorizeSettingsSync(context);
  context.subscriptions.push(TableEditorProvider.register(context));
  context.subscriptions.push(registerJupyterVariableViewer(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('dataViewer.open', async (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showErrorMessage('Data Viewer: no file selected.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, TableEditorProvider.viewType);
    })
  );
}

export function deactivate(): void {}
