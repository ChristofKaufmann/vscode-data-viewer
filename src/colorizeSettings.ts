// Persisted view-UI settings, kept in the extension's global state so a choice
// made in one view carries over to the next (and across sessions): the Colorize
// options plus the Graphs stats-section toggle.
//
// vscode is imported as a type only, so this module has no runtime dependency
// on the editor host and can be unit-tested with a fake context.
import type * as vscode from 'vscode';
import { DEFAULT_COLORMAP } from './pandasTable';

export interface ColorizeSettings {
  colorizeNumeric: boolean;
  colorizeDatetime: boolean;
  colorizeOrdered: boolean;
  colorizeUnordered: boolean;
  colormap: string;
  center: boolean;
  columnwise: boolean;
  /** Show the stats section — missing/available bar + distributions (Graphs toggle). */
  showGraphs: boolean;
}

const STATE_KEY = 'dataViewer.colorize';

export function getColorizeSettings(context: vscode.ExtensionContext): ColorizeSettings {
  const saved = context.globalState.get<Partial<ColorizeSettings>>(STATE_KEY) ?? {};
  return {
    colorizeNumeric: saved.colorizeNumeric ?? true,
    colorizeDatetime: saved.colorizeDatetime ?? true,
    colorizeOrdered: saved.colorizeOrdered ?? true,
    colorizeUnordered: saved.colorizeUnordered ?? false,
    colormap: saved.colormap ?? DEFAULT_COLORMAP,
    center: saved.center ?? false,
    columnwise: saved.columnwise ?? true,
    showGraphs: saved.showGraphs ?? true,
  };
}

export function updateColorizeSettings(
  context: vscode.ExtensionContext,
  settings: ColorizeSettings
): Thenable<void> {
  return context.globalState.update(STATE_KEY, settings);
}

/**
 * Opt the persisted settings into Settings Sync, so the choices roam across a
 * user's machines (extension `globalState` is otherwise local to each install).
 * Call once on activation.
 */
export function registerColorizeSettingsSync(context: vscode.ExtensionContext): void {
  context.globalState.setKeysForSync([STATE_KEY]);
}
