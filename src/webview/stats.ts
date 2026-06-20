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
 * A thin tick strip (its own full-width SVG below the bars) marking the
 * min/median/max positions. Kept out of the bar chart so the ticks sit just
 * below the graph at a fixed pixel height instead of scaling with the bars.
 * x maps each value's 0..1 fraction across a 0..100 viewBox (full width, like
 * the bars), so the ticks line up with the chart.
 *
 * min/max are straight ticks (their labels hug the strip's edges). The median's
 * label is centered (x=50), so its tick routes down half-way, across to the
 * label, then down the rest — an elbow connecting the exact position to the
 * centered label, which is most visible when the median is off-center (skew).
 */
export function tickStripSvg(minF: number, medianF: number, maxF: number): string {
  const x = (f: number) => Math.round(Math.max(0, Math.min(1, f)) * 1000) / 10;
  const tick = (f: number) =>
    `<line x1="${x(f)}" y1="0" x2="${x(f)}" y2="10" vector-effect="non-scaling-stroke"/>`;
  const mx = x(medianF);
  const median = `<path d="M${mx} 0 L${mx} 5 L50 5 L50 10" fill="none" vector-effect="non-scaling-stroke"/>`;
  return `<svg class="hist-ticks" viewBox="0 0 100 10" preserveAspectRatio="none">${tick(minF)}${median}${tick(maxF)}</svg>`;
}

/**
 * A horizontal stacked bar: one segment per value, widths proportional to the
 * counts, in a 0..100 viewBox with `preserveAspectRatio="none"` (full width,
 * fixed height via CSS). A small gap separates segments. Per-segment fill is
 * applied in the DOM afterwards, like the categorical bars.
 */
export function stackedBarSvg(counts: number[]): string {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const gap = 0.6;
  const avail = Math.max(0, 100 - gap * Math.max(0, counts.length - 1));
  const round = (v: number) => Math.round(v * 100) / 100;
  let x = 0;
  const rects = counts
    .map((c) => {
      const w = (c / total) * avail;
      const rect = `<rect x="${round(x)}" y="0" width="${round(w)}" height="10"/>`;
      x += w + gap;
      return rect;
    })
    .join('');
  return `<svg class="stacked" viewBox="0 0 100 10" preserveAspectRatio="none">${rects}</svg>`;
}

/**
 * Segments for the available/missing split bar shown above the missing count.
 * Rendered as flex `<div>`s (not a stretching SVG) so each segment's minimum is
 * an absolute CSS `min-width` in px that survives column resizing; `grow` is the
 * flex-grow weight (the raw count) that distributes the remaining width. One
 * full-width segment when all values are available or all missing (not
 * clickable); two segments otherwise. `clickable` is true only when both are
 * present (so a click maps to notna/isna).
 */
export function naBar(
  available: number,
  missing: number
): { segments: { kind: 'avail' | 'missing'; grow: number }[]; clickable: boolean } {
  const total = available + missing;
  if (total <= 0) {
    return { segments: [], clickable: false };
  }
  if (missing <= 0) {
    return { segments: [{ kind: 'avail', grow: 1 }], clickable: false };
  }
  if (available <= 0) {
    return { segments: [{ kind: 'missing', grow: 1 }], clickable: false };
  }
  return {
    segments: [
      { kind: 'avail', grow: available },
      { kind: 'missing', grow: missing },
    ],
    clickable: true,
  };
}

/**
 * Segment under a 0..1 fraction of a stacked bar's width (segments have varying
 * widths, so this isn't a uniform-bin lookup). Returns the index and the
 * segment's center as a fraction, for placing the hover bubble. Gaps between
 * segments are ignored (negligible) so it maps purely by cumulative count.
 */
export function segmentAt(counts: number[], fraction: number): { index: number; center: number } {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { index: 0, center: 0 };
  }
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    if (target < acc + counts[i] || i === counts.length - 1) {
      return { index: i, center: (acc + counts[i] / 2) / total };
    }
    acc += counts[i];
  }
  return { index: counts.length - 1, center: 0.5 };
}

/**
 * Position of `value` as a 0..1 fraction of the chart width (which spans the
 * nice-grid edges, not the data extent), clamped into range.
 */
export function markerFraction(edges: number[], value: number): number {
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  if (!(hi > lo)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
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

/** A numeric/datetime/timedelta column's histogram, as shipped in `ColumnStat`. */
export interface Histogram {
  counts: number[];
  /** Bin edge *positions* (numeric for geometry); length is `counts.length + 1`. */
  edges: number[];
  /** Per-bin colormap fill (bin center mapped over the data extent), or null. */
  colors?: (string | null)[] | null;
  /** Per-bin pandas `query` clause (`col >= lo & col < hi`) for click-to-filter. */
  filters?: (string | null)[] | null;
  /** Actual data min/median/max positions, within the edge range. */
  min: number;
  median: number;
  max: number;
  /**
   * Display strings for datetime/timedelta axes (date / duration text), shown in
   * place of `formatNumber` on the numeric positions. Absent for numeric columns.
   */
  labels?: { edges: string[]; min: string; median: string; max: string };
}

/**
 * Bin index under a horizontal position given as a 0..1 fraction of the chart
 * width, clamped into range (so the edges still map to the first/last bin).
 */
export function binIndexAt(fraction: number, bins: number): number {
  return Math.max(0, Math.min(bins - 1, Math.floor(fraction * bins)));
}

/**
 * Formats a number with a decimal point regardless of the UI locale (edges are
 * pre-rounded in Python, so we print them faithfully). Large magnitudes get a
 * thin-space (U+2009) thousands separator for readability, but only at
 * |value| >= 10000 — smaller numbers stay ungrouped (e.g. 9999, not 9 999).
 */
export function formatNumber(value: number): string {
  const grouped = Math.abs(value) >= 10000;
  const text = value.toLocaleString('en-US', {
    maximumFractionDigits: 20,
    useGrouping: grouped,
  });
  // en-US groups with "," and uses "." for the decimal, so swapping commas for
  // thin spaces leaves the decimal point intact.
  return grouped ? text.replace(/,/g, ' ') : text;
}

/** Edge values [lo, hi) and count for bin `i`, read off the nice-grid edges. */
export function histogramBin(hist: Histogram, i: number): { lo: number; hi: number; count: number } {
  return {
    lo: hist.edges[i],
    hi: hist.edges[i + 1],
    count: hist.counts[i] ?? 0,
  };
}
