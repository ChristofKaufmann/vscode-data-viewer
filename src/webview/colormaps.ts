// 16-stop hex samples of each offered colormap, generated once from matplotlib
// (regenerate if the colormap list in tableWebview.ts changes). Used only to
// draw a small preview swatch — the actual cell colors are computed in Python.
export const CMAP_STOPS: Record<string, string[]> = {
  viridis: ['#440154', '#481a6c', '#472f7d', '#414487', '#39568c', '#31688e', '#2a788e', '#23888e', '#1f988b', '#22a884', '#35b779', '#54c568', '#7ad151', '#a5db36', '#d2e21b', '#fde725'],
  plasma: ['#0d0887', '#330597', '#5002a2', '#6a00a8', '#8405a7', '#9c179e', '#b12a90', '#c33d80', '#d35171', '#e16462', '#ed7953', '#f68f44', '#fca636', '#fec029', '#f9dc24', '#f0f921'],
  inferno: ['#000004', '#0c0826', '#240c4f', '#420a68', '#5d126e', '#781c6d', '#932667', '#ae305c', '#c73e4c', '#dd513a', '#ed6925', '#f8850f', '#fca50a', '#fac62d', '#f2e661', '#fcffa4'],
  magma: ['#000004', '#0b0924', '#20114b', '#3b0f70', '#57157e', '#721f81', '#8c2981', '#a8327d', '#c43c75', '#de4968', '#f1605d', '#fa7f5e', '#fe9f6d', '#febf84', '#fddea0', '#fcfdbf'],
  cividis: ['#00224e', '#002e6c', '#1e3a6f', '#35456c', '#47516c', '#575d6d', '#666970', '#757575', '#848279', '#948e77', '#a59c74', '#b7a96e', '#c8b866', '#dbc75a', '#eed649', '#fee838'],
  Blues: ['#f7fbff', '#eaf2fb', '#dceaf6', '#d0e1f2', '#c1d9ed', '#abd0e6', '#94c4df', '#79b5d9', '#60a7d2', '#4a98c9', '#3787c0', '#2575b7', '#1764ab', '#0a539e', '#084285', '#08306b'],
  Greens: ['#f7fcf5', '#edf8ea', '#e3f4de', '#d3eecd', '#c2e7bb', '#aedea7', '#98d594', '#80ca80', '#66bd6f', '#4bb062', '#37a055', '#278f48', '#157f3b', '#026f2e', '#005a24', '#00441b'],
  Oranges: ['#fff5eb', '#feeddc', '#fee5cb', '#fdd9b4', '#fdcb9b', '#fdb97d', '#fda762', '#fd9649', '#fa8331', '#f3701b', '#e95e0d', '#dc4c03', '#c54102', '#a93703', '#942f03', '#7f2704'],
  Greys: ['#ffffff', '#f7f7f7', '#eeeeee', '#e2e2e2', '#d5d5d5', '#c6c6c6', '#b5b5b5', '#a0a0a0', '#8d8d8d', '#7a7a7a', '#686868', '#565656', '#404040', '#282828', '#141414', '#000000'],
  coolwarm: ['#3b4cc0', '#4f69d9', '#6485ec', '#7b9ff9', '#93b5fe', '#aac7fd', '#c0d4f5', '#d4dbe6', '#e5d8d1', '#f2cbb7', '#f7b89c', '#f5a081', '#ee8468', '#e0654f', '#cc403a', '#b40426'],
  RdBu: ['#67001f', '#991027', '#be3036', '#d6604d', '#ea8e70', '#f7b799', '#fddbc7', '#f9eee7', '#eaf1f5', '#d1e5f0', '#a7d0e4', '#78b4d5', '#4393c3', '#2c75b4', '#185493', '#053061'],
  Spectral: ['#9e0142', '#c32a4b', '#df4e4b', '#f46d43', '#fa9857', '#fdbf6f', '#fee08b', '#fff5ae', '#f7fcb2', '#e6f598', '#bfe5a0', '#94d4a4', '#66c2a5', '#439bb5', '#4175b4', '#5e4fa2'],
  bwr: ['#0000ff', '#2222ff', '#4444ff', '#6666ff', '#8888ff', '#aaaaff', '#ccccff', '#eeeeff', '#ffeeee', '#ffcccc', '#ffaaaa', '#ff8888', '#ff6666', '#ff4444', '#ff2222', '#ff0000'],
};

/**
 * A hard-stop `linear-gradient` that renders the stops as equal-width solid
 * segments (16 stops → 16 blocks). Returns '' for an unknown colormap.
 */
export function steppedGradient(name: string): string {
  const stops = CMAP_STOPS[name];
  if (!stops || stops.length === 0) {
    return '';
  }
  const seg = 100 / stops.length;
  const parts = stops.map((color, i) => `${color} ${i * seg}% ${(i + 1) * seg}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
