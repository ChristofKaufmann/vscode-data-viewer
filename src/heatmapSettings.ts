// Heatmap UI settings, persisted in the extension's global state so a choice
// made in one view carries over to the next (and across sessions).
//
// vscode is imported as a type only, so this module has no runtime dependency
// on the editor host and can be unit-tested with a fake context.
import type * as vscode from 'vscode';
import { HEATMAP_CMAP } from './pandasTable';

export interface HeatmapSettings {
  enabled: boolean;
  colormap: string;
  center: boolean;
}

const STATE_KEY = 'dataViewer.heatmap';

export function getHeatmapSettings(context: vscode.ExtensionContext): HeatmapSettings {
  const saved = context.globalState.get<Partial<HeatmapSettings>>(STATE_KEY) ?? {};
  return {
    enabled: saved.enabled ?? true,
    colormap: saved.colormap ?? HEATMAP_CMAP,
    center: saved.center ?? false,
  };
}

export function updateHeatmapSettings(
  context: vscode.ExtensionContext,
  settings: HeatmapSettings
): Thenable<void> {
  return context.globalState.update(STATE_KEY, settings);
}
