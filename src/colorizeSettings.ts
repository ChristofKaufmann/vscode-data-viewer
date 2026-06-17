// Colorize UI settings, persisted in the extension's global state so a choice
// made in one view carries over to the next (and across sessions).
//
// vscode is imported as a type only, so this module has no runtime dependency
// on the editor host and can be unit-tested with a fake context.
import type * as vscode from 'vscode';
import { DEFAULT_COLORMAP } from './pandasTable';

export interface ColorizeSettings {
  colorizeNumeric: boolean;
  colorizeDatetime: boolean;
  colorizeCategorical: boolean;
  colorizeText: boolean;
  colormap: string;
  center: boolean;
  columnwise: boolean;
}

const STATE_KEY = 'dataViewer.colorize';

export function getColorizeSettings(context: vscode.ExtensionContext): ColorizeSettings {
  const saved = context.globalState.get<Partial<ColorizeSettings>>(STATE_KEY) ?? {};
  return {
    colorizeNumeric: saved.colorizeNumeric ?? true,
    colorizeDatetime: saved.colorizeDatetime ?? true,
    colorizeCategorical: saved.colorizeCategorical ?? true,
    colorizeText: saved.colorizeText ?? false,
    colormap: saved.colormap ?? DEFAULT_COLORMAP,
    center: saved.center ?? false,
    columnwise: saved.columnwise ?? false,
  };
}

export function updateColorizeSettings(
  context: vscode.ExtensionContext,
  settings: ColorizeSettings
): Thenable<void> {
  return context.globalState.update(STATE_KEY, settings);
}
