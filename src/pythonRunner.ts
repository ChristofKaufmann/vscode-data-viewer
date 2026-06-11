import * as vscode from 'vscode';
import { spawn } from 'child_process';
import type { PythonExtension } from '@vscode/python-extension';

const log = vscode.window.createOutputChannel('Data Viewer');

/** A Python failure the user can likely fix by picking another interpreter. */
export class PythonEnvironmentError extends Error {
  constructor(
    message: string,
    readonly python: string
  ) {
    super(message);
  }
}

/**
 * Resolves the Python interpreter selected in the Python extension for the
 * given resource, falling back to `python3` on PATH.
 */
async function getPythonPath(resource?: vscode.Uri): Promise<string> {
  try {
    const ext = vscode.extensions.getExtension<PythonExtension>('ms-python.python');
    if (ext) {
      const api = await ext.activate();
      const envPath = api.environments.getActiveEnvironmentPath(resource);
      const resolved = await api.environments.resolveEnvironment(envPath);
      const executable = resolved?.executable.uri?.fsPath ?? envPath.path;
      if (executable) {
        log.appendLine(`Using interpreter from Python extension: ${executable}`);
        return executable;
      }
      log.appendLine(`Python extension returned no executable for "${envPath.path}".`);
    } else {
      log.appendLine('Python extension (ms-python.python) not found.');
    }
  } catch (err) {
    log.appendLine(`Python extension lookup failed: ${err instanceof Error ? err.message : err}`);
  }
  log.appendLine('Falling back to "python3" on PATH.');
  return 'python3';
}

export function canSelectInterpreter(): boolean {
  return vscode.extensions.getExtension('ms-python.python') !== undefined;
}

/** Opens the Python extension's interpreter picker. */
export async function selectInterpreter(): Promise<void> {
  await vscode.commands.executeCommand('python.setInterpreter');
}

export async function runPythonScript(
  code: string,
  resource?: vscode.Uri,
  token?: vscode.CancellationToken
): Promise<string> {
  const python = await getPythonPath(resource);
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(python, ['-c', code]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    token?.onCancellationRequested(() => proc.kill());
    proc.on('error', (err) => {
      reject(
        new PythonEnvironmentError(`Could not start Python ("${python}"): ${err.message}`, python)
      );
    });
    proc.on('close', (exitCode) => {
      if (token?.isCancellationRequested) {
        reject(new Error('Cancelled.'));
      } else if (exitCode === 0) {
        resolve(stdout);
      } else if (/No module named ['"]?pandas/.test(stderr)) {
        reject(
          new PythonEnvironmentError(
            `The Python environment "${python}" does not have pandas installed.`,
            python
          )
        );
      } else {
        log.appendLine(`Python error (${python}):\n${stderr.trim()}`);
        const lines = stderr.trim().split('\n');
        reject(new Error(lines.slice(-3).join('\n') || `Python ("${python}") exited with an error.`));
      }
    });
  });
}
