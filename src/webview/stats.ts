// Pure helpers for the column-statistics row. Kept free of DOM/global access
// so the formatting behavior can be pinned down by unit tests.

/**
 * Formats a percentage for the stats row: rounded to a whole number once it
 * reaches 10%, and to one decimal below that (so small-but-nonzero shares keep
 * some precision instead of collapsing to "0%").
 */
export function formatPercent(p: number): string {
  if (p >= 10) {
    return `${Math.round(p)}%`;
  }
  return `${p.toFixed(1)}%`;
}

// Histogram drawing constants, in viewBox units (the SVG stretches to the cell
// via preserveAspectRatio="none", so these are resolution-independent).
const HIST_VIEW_H = 100;
/** Minimum bar height so even empty bins stay visible as a baseline tick. */
const HIST_MIN_BAR = 8;
/** Fraction of each bin's slot left as a gap between bars. */
const HIST_BAR_GAP = 0.15;

/**
 * Builds an inline SVG bar chart for a numeric column's histogram. The viewBox
 * is `0 0 <bins> 100` with `preserveAspectRatio="none"`, so the chart scales to
 * whatever width/height the cell has — it never needs rebuilding on resize.
 * Bars are scaled to the tallest bin; empty bins still get HIST_MIN_BAR so the
 * full extent of the distribution stays visible.
 */
/** Bar height in viewBox units for a bin, scaled to the tallest (with a floor). */
function barHeight(count: number, max: number): number {
  const ratio = max > 0 ? count / max : 0;
  return HIST_MIN_BAR + ratio * (HIST_VIEW_H - HIST_MIN_BAR);
}

export function histogramSvg(counts: number[]): string {
  const n = counts.length;
  const max = counts.reduce((a, b) => Math.max(a, b), 0);
  const round = (v: number) => Math.round(v * 100) / 100;
  const rects = counts
    .map((count, i) => {
      const h = barHeight(count, max);
      const x = i + HIST_BAR_GAP / 2;
      const w = 1 - HIST_BAR_GAP;
      return `<rect x="${round(x)}" y="${round(HIST_VIEW_H - h)}" width="${round(w)}" height="${round(h)}"/>`;
    })
    .join('');
  return `<svg class="hist" viewBox="0 0 ${n} ${HIST_VIEW_H}" preserveAspectRatio="none">${rects}</svg>`;
}

/**
 * Top edge of bin `i`'s bar as a fraction of the chart height (0 = chart top,
 * 1 = chart bottom). Lets the hover bubble sit above the bar itself rather than
 * above the whole chart; uses the same scaling as the drawn bars.
 */
export function barTopFraction(counts: number[], i: number): number {
  const max = counts.reduce((a, b) => Math.max(a, b), 0);
  return (HIST_VIEW_H - barHeight(counts[i] ?? 0, max)) / HIST_VIEW_H;
}

/** A numeric column's histogram on a "nice" rounded grid, as shipped in `ColumnStat`. */
export interface Histogram {
  counts: number[];
  /** Bin edges on the nice grid; length is `counts.length + 1`. */
  edges: number[];
}

/**
 * Bin index under a horizontal position given as a 0..1 fraction of the chart
 * width, clamped into range (so the edges still map to the first/last bin).
 */
export function binIndexAt(fraction: number, bins: number): number {
  return Math.max(0, Math.min(bins - 1, Math.floor(fraction * bins)));
}

/**
 * Formats a number with a decimal point regardless of the UI locale and without
 * grouping — so histogram bin edges read the same way as the table cells, which
 * come straight from pandas (always a point). Edges are already rounded to a
 * clean precision in Python, so we just print them faithfully.
 */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 20, useGrouping: false });
}

/** Edge values [lo, hi) and count for bin `i`, read off the nice-grid edges. */
export function histogramBin(hist: Histogram, i: number): { lo: number; hi: number; count: number } {
  return {
    lo: hist.edges[i],
    hi: hist.edges[i + 1],
    count: hist.counts[i] ?? 0,
  };
}
