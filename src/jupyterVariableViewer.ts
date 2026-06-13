import * as vscode from 'vscode';
import type { Jupyter, Kernel } from '@vscode/jupyter-extension';
import { buildDumpCode, DumpPayload, parsePayload, toTable } from './pandasTable';
import { configureTableWebview, LoadOptions, TableData } from './tableWebview';

/**
 * Shape of the argument the Jupyter extension passes to a contributed
 * `jupyterVariableViewers` command (the blessed subset from
 * vscode-jupyter's api.proposed.variables.d.ts, plus `frameId` which is
 * set when the request comes from the debugger variables pane).
 */
interface JupyterVariable {
  name: string;
  type: string;
  fileName?: { path: string };
  frameId?: number;
}

// The api.d.ts doc comment claims 'application/x.notebook.stream.stdout', but the
// implementation emits the NotebookCellOutputItem.stdout mime — accept both.
const STDOUT_MIMES = new Set([
  'application/vnd.code.notebook.stdout',
  'application/x.notebook.stream.stdout',
]);
const ERROR_MIME = 'application/vnd.code.notebook.error';

export function registerJupyterVariableViewer(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand(
    'dataViewer.openJupyterVariable',
    async (variable?: JupyterVariable) => {
      try {
        await openVariable(context, variable);
      } catch (err) {
        const message =
          err instanceof Error && err.name === 'vscode.jupyter.apiAccessRevoked'
            ? 'Data Viewer was denied access to Jupyter kernels. Run "Jupyter: Manage Access To Jupyter Kernels" to change this.'
            : `Data Viewer: failed to load variable. ${err instanceof Error ? err.message : String(err)}`;
        void vscode.window.showErrorMessage(message);
      }
    }
  );
}

async function openVariable(
  context: vscode.ExtensionContext,
  variable?: JupyterVariable
): Promise<void> {
  if (!variable?.name) {
    throw new Error('No variable provided. This command is invoked from the Jupyter variables panel.');
  }
  if (variable.frameId !== undefined) {
    throw new Error('Variables from the debugger are not supported yet.');
  }
  if (!/^[A-Za-z_]\w*$/.test(variable.name)) {
    throw new Error(`Unsupported variable name: ${variable.name}`);
  }

  // `fileName` is the URI of the notebook owning the variable. It crosses the
  // command boundary as a plain object, so compare by path (as Data Wrangler does).
  const notebook = variable.fileName
    ? vscode.workspace.notebookDocuments.find((d) => d.uri.path === variable.fileName!.path)
    : vscode.window.activeNotebookEditor?.notebook;
  if (!notebook) {
    throw new Error('Could not find the notebook this variable belongs to.');
  }

  const jupyterExt = vscode.extensions.getExtension<Jupyter>('ms-toolsai.jupyter');
  if (!jupyterExt) {
    throw new Error('The Jupyter extension (ms-toolsai.jupyter) is required.');
  }
  const api = await jupyterExt.activate();

  const variableName = variable.name;
  const notebookName = notebook.uri.path.split('/').pop() ?? 'notebook';

  // Re-acquired on every (re)load so refresh picks up the current value and
  // survives a kernel restart.
  const load = async (options: LoadOptions): Promise<TableData> => {
    const kernel = await api.kernels.getKernel(notebook.uri);
    if (!kernel) {
      throw new Error('No running kernel found for the notebook. Run a cell first.');
    }
    if (kernel.language !== 'python') {
      throw new Error(`Only Python kernels are supported for now (got "${kernel.language}").`);
    }
    try {
      const payload = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Data Viewer: loading "${variableName}"…`,
          cancellable: true,
        },
        (_progress, token) =>
          fetchVariable(kernel, variableName, options.colormap, options.center, token)
      );
      return { fileName: `${variableName} — ${notebookName}`, ...toTable(payload) };
    } catch (err) {
      if (err instanceof Error && err.name === 'vscode.jupyter.apiAccessRevoked') {
        throw new Error(
          'Data Viewer was denied access to Jupyter kernels. Run "Jupyter: Manage Access To Jupyter Kernels" to change this.'
        );
      }
      throw err;
    }
  };

  const panel = vscode.window.createWebviewPanel(
    'dataViewer.variableTable',
    variableName,
    vscode.ViewColumn.Active,
    { retainContextWhenHidden: true }
  );
  const subscription = configureTableWebview(panel.webview, context, load);
  panel.onDidDispose(() => subscription.dispose());
}

async function fetchVariable(
  kernel: Kernel,
  name: string,
  colormap: string | undefined,
  center: boolean | undefined,
  token: vscode.CancellationToken
): Promise<DumpPayload> {
  let stdout = '';
  let textPlain = '';
  const seenMimes = new Set<string>();
  for await (const output of kernel.executeCode(buildDumpCode(name, colormap, center), token)) {
    for (const item of output.items) {
      seenMimes.add(item.mime);
      const text = new TextDecoder().decode(item.data);
      if (STDOUT_MIMES.has(item.mime)) {
        stdout += text;
      } else if (item.mime === 'text/plain') {
        // Fallback: some transports surface the result as execute_result text.
        textPlain += text;
      } else if (item.mime === ERROR_MIME) {
        const error = JSON.parse(text) as { name?: string; message?: string };
        throw new Error(`${error.name ?? 'Error'}: ${error.message ?? 'unknown kernel error'}`);
      }
    }
  }
  if (token.isCancellationRequested) {
    throw new Error('Cancelled.');
  }
  const merged = stdout || textPlain;
  if (!merged.trim()) {
    throw new Error(
      `The kernel returned no data (received output types: ${[...seenMimes].join(', ') || 'none'}).`
    );
  }
  return parsePayload(merged);
}
