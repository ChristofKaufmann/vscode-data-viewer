import * as vscode from 'vscode';
import type { Jupyter, Kernel } from '@vscode/jupyter-extension';
import { configureTableWebview } from './tableWebview';

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

const MAX_ROWS = 100_000;
// The api.d.ts doc comment claims 'application/x.notebook.stream.stdout', but the
// implementation emits the NotebookCellOutputItem.stdout mime — accept both.
const STDOUT_MIMES = new Set([
  'application/vnd.code.notebook.stdout',
  'application/x.notebook.stream.stdout',
]);
const ERROR_MIME = 'application/vnd.code.notebook.error';

interface DumpPayload {
  total: number;
  showIndex: boolean;
  indexName: string;
  table: { columns: string[]; index: unknown[]; data: unknown[][] };
}

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

  const kernel = await api.kernels.getKernel(notebook.uri);
  if (!kernel) {
    throw new Error('No running kernel found for the notebook. Run a cell first.');
  }
  if (kernel.language !== 'python') {
    throw new Error(`Only Python kernels are supported for now (got "${kernel.language}").`);
  }

  const payload = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Data Viewer: loading "${variable.name}"…`,
      cancellable: true,
    },
    (_progress, token) => fetchVariable(kernel, variable.name, token)
  );

  const { columns, rows, truncated } = toTable(payload);

  const panel = vscode.window.createWebviewPanel(
    'dataViewer.variableTable',
    variable.name,
    vscode.ViewColumn.Active,
    { retainContextWhenHidden: true }
  );
  const subscription = configureTableWebview(panel.webview, context.extensionUri, {
    fileName: `${variable.name} — ${notebook.uri.path.split('/').pop() ?? 'notebook'}`,
    note: truncated
      ? `showing first ${MAX_ROWS.toLocaleString()} of ${payload.total.toLocaleString()} rows`
      : undefined,
    columns,
    rows,
  });
  panel.onDidDispose(() => subscription.dispose());
}

async function fetchVariable(
  kernel: Kernel,
  name: string,
  token: vscode.CancellationToken
): Promise<DumpPayload> {
  let stdout = '';
  let textPlain = '';
  const seenMimes = new Set<string>();
  for await (const output of kernel.executeCode(buildDumpCode(name), token)) {
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
  const trimmed = (stdout || textPlain).trim();
  if (!trimmed) {
    throw new Error(
      `The kernel returned no data (received output types: ${[...seenMimes].join(', ') || 'none'}).`
    );
  }
  return JSON.parse(trimmed) as DumpPayload;
}

/**
 * Serializes the variable as JSON on the kernel's stdout. Everything runs
 * inside a function so the user's namespace only ever sees (and loses) one
 * temporary name. Series/ndarray/list/dict are normalized via pandas, which
 * must be importable in the kernel (always true for DataFrame/Series).
 */
function buildDumpCode(name: string): string {
  return [
    'def _VSCODE_dataviewer_dump():',
    '    import json',
    '    import pandas as pd',
    `    obj = ${name}`,
    '    if isinstance(obj, pd.Series):',
    '        obj = obj.to_frame()',
    '    elif not isinstance(obj, pd.DataFrame):',
    '        obj = pd.DataFrame(obj)',
    '    total = len(obj)',
    `    head = obj.head(${MAX_ROWS}).copy()`,
    '    show_index = not (isinstance(head.index, pd.RangeIndex) and head.index.start == 0 and head.index.step == 1)',
    '    index_name = str(head.index.name) if head.index.name is not None else "index"',
    '    head.columns = [str(c) for c in head.columns]',
    '    if isinstance(head.index, pd.MultiIndex):',
    '        head.index = [str(i) for i in head.index]',
    '    table = head.to_json(orient="split", date_format="iso", default_handler=str)',
    '    print(\'{"total": %d, "showIndex": %s, "indexName": %s, "table": %s}\'',
    '          % (total, "true" if show_index else "false", json.dumps(index_name), table))',
    '',
    '_VSCODE_dataviewer_dump()',
    'del _VSCODE_dataviewer_dump',
  ].join('\n');
}

function toTable(payload: DumpPayload): { columns: string[]; rows: string[][]; truncated: boolean } {
  const { table, showIndex } = payload;
  const format = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  const columns = showIndex ? [payload.indexName, ...table.columns] : table.columns;
  const rows = table.data.map((row, i) => {
    const cells = row.map(format);
    return showIndex ? [format(table.index[i]), ...cells] : cells;
  });
  return { columns, rows, truncated: payload.total > table.data.length };
}
