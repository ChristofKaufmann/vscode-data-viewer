import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Jupyter, Kernel } from '@vscode/jupyter-extension';
import { buildDumpCode, DumpOptions, DumpPayload, parsePayload, toTable } from './pandasTable';
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
  if (!/^[A-Za-z_]\w*$/.test(variable.name)) {
    throw new Error(`Unsupported variable name: ${variable.name}`);
  }
  // A frameId means the request came from the debugger's variables pane, which has
  // no kernel — the value lives in a paused stack frame, reached over the Debug
  // Adapter Protocol instead.
  if (variable.frameId !== undefined) {
    return openDebugVariable(context, variable);
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
        (_progress, token) => fetchVariable(kernel, variableName, options, token)
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
  // Tab icon (variable views get a webview panel, which otherwise shows a generic
  // glyph; file views are custom editors and pick up the file-type icon instead).
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon', 'icon.png');
  const subscription = configureTableWebview(panel.webview, context, load);
  panel.onDidDispose(() => subscription.dispose());
}

async function fetchVariable(
  kernel: Kernel,
  name: string,
  options: DumpOptions,
  token: vscode.CancellationToken
): Promise<DumpPayload> {
  let stdout = '';
  let textPlain = '';
  const seenMimes = new Set<string>();
  const code = buildDumpCode(name, options);
  for await (const output of kernel.executeCode(code, token)) {
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

// A monotonically increasing suffix so concurrent/refreshed debug dumps never
// collide on the same temp file.
let _debugDumpSeq = 0;

async function openDebugVariable(
  context: vscode.ExtensionContext,
  variable: JupyterVariable
): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    throw new Error('No active debug session. Open the variable while the debugger is paused.');
  }
  if (session.type !== 'python' && session.type !== 'debugpy') {
    throw new Error(`Only the Python debugger is supported (got "${session.type}").`);
  }

  const variableName = variable.name;
  // Resolve the thread owning the frame the command was invoked on, so each load
  // can re-read its *current* top frame (the originally captured frame goes stale
  // the moment the program steps or continues).
  const threadId = await resolveThreadId(session, variable.frameId!);

  const load = async (options: LoadOptions): Promise<TableData> => {
    const payload = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Data Viewer: loading "${variableName}"…`,
        cancellable: false,
      },
      () => fetchDebugVariable(session, threadId, variable.frameId!, variableName, options)
    );
    return { fileName: `${variableName} — debugger`, ...toTable(payload) };
  };

  const panel = vscode.window.createWebviewPanel(
    'dataViewer.variableTable',
    variableName,
    vscode.ViewColumn.Active,
    { retainContextWhenHidden: true }
  );
  // Tab icon (variable views get a webview panel, which otherwise shows a generic
  // glyph; file views are custom editors and pick up the file-type icon instead).
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon', 'icon.png');
  const subscription = configureTableWebview(panel.webview, context, load);
  panel.onDidDispose(() => subscription.dispose());
}

/** Finds the threadId whose stack contains `frameId`; falls back to the first thread. */
async function resolveThreadId(
  session: vscode.DebugSession,
  frameId: number
): Promise<number | undefined> {
  try {
    const { threads } = (await session.customRequest('threads')) as {
      threads?: { id: number }[];
    };
    for (const t of threads ?? []) {
      try {
        const { stackFrames } = (await session.customRequest('stackTrace', {
          threadId: t.id,
          startFrame: 0,
          levels: 50,
        })) as { stackFrames?: { id: number }[] };
        if ((stackFrames ?? []).some((f) => f.id === frameId)) {
          return t.id;
        }
      } catch {
        // Thread may have resumed; try the next.
      }
    }
    return threads?.[0]?.id;
  } catch {
    return undefined;
  }
}

async function fetchDebugVariable(
  session: vscode.DebugSession,
  threadId: number | undefined,
  fallbackFrameId: number,
  name: string,
  options: DumpOptions
): Promise<DumpPayload> {
  // Re-resolve the current top frame of the thread so Refresh tracks the program
  // as it steps; fall back to the frame the command was first invoked on.
  let frameId = fallbackFrameId;
  if (threadId !== undefined) {
    try {
      const { stackFrames } = (await session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: 1,
      })) as { stackFrames?: { id: number }[] };
      if (stackFrames && stackFrames.length) {
        frameId = stackFrames[0].id;
      }
    } catch {
      // Not paused (e.g. running/terminated) — fall through to the stale frame and
      // let the evaluate below surface a clear error.
    }
  }

  const tmpFile = path.join(os.tmpdir(), `dataviewer-${process.pid}-${_debugDumpSeq++}.json`);
  const code = buildDumpCode(name, { ...options, outputFile: tmpFile });
  // DAP `evaluate` only returns a value for a single expression, not a multi-line
  // script, and doesn't cleanly hand back stdout — so wrap the whole script in one
  // `exec(...)` that writes its JSON to the temp file. base64 avoids any quoting/
  // escaping issues, and merging the frame's globals+locals into exec's namespace
  // makes the target variable (a frame local) visible to the generated function.
  const b64 = Buffer.from(code, 'utf-8').toString('base64');
  const expression =
    `exec(__import__('base64').b64decode(${JSON.stringify(b64)}).decode('utf-8'), ` +
    `{**globals(), **locals()})`;

  try {
    await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
    const text = await fs.readFile(tmpFile, 'utf-8');
    if (!text.trim()) {
      throw new Error('The debugger returned no data.');
    }
    return parsePayload(text);
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}
