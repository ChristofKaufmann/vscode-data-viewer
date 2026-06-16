import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barTopFraction,
  binIndexAt,
  formatNumber,
  formatPercent,
  histogramBin,
  histogramSvg,
  markerFraction,
  tickStripSvg,
} from '../src/webview/stats';

test('formatPercent rounds to a whole number at 10% and above', () => {
  assert.equal(formatPercent(10), '10%');
  assert.equal(formatPercent(30), '30%');
  assert.equal(formatPercent(33.4), '33%');
  assert.equal(formatPercent(99.6), '100%');
});

test('formatPercent keeps one decimal below 10%', () => {
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(3), '3.0%');
  assert.equal(formatPercent(5.24), '5.2%');
  assert.equal(formatPercent(9.99), '10.0%'); // rounds up but stays below the integer threshold
});

test('histogramSvg draws one bar per bin in a bins×100 viewBox', () => {
  const svg = histogramSvg([0, 5, 10]);
  assert.match(svg, /viewBox="0 0 3 100"/);
  assert.match(svg, /preserveAspectRatio="none"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 3);
});

test('histogramSvg scales to the tallest bin and floors empty bins', () => {
  const heights = [...histogramSvg([0, 5, 10]).matchAll(/height="([\d.]+)"/g)].map((m) =>
    Number(m[1])
  );
  assert.equal(heights[2], 100); // tallest bin fills the height
  assert.equal(heights[0], 8); // empty bin keeps the minimum bar
  assert.ok(heights[1] > 8 && heights[1] < 100);
});

test('histogramSvg floors every bin to the minimum when all counts are zero', () => {
  const heights = [...histogramSvg([0, 0]).matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(heights, [8, 8]);
});

test('formatNumber uses a decimal point and no grouping, regardless of locale', () => {
  assert.equal(formatNumber(-2.4), '-2.4');
  assert.equal(formatNumber(0.05), '0.05'); // faithful — edges are pre-rounded in Python
  assert.equal(formatNumber(1000), '1000'); // no thousands separator
  assert.equal(formatNumber(0), '0');
});

test('barTopFraction tracks the bar height (0 at top for the tallest bin)', () => {
  const counts = [0, 5, 10];
  // Tallest bin fills the chart: its top is at the chart top (fraction 0).
  assert.equal(barTopFraction(counts, 2), 0);
  // Empty bin only gets the minimum bar (8/100 tall), so its top is near the bottom.
  assert.ok(Math.abs(barTopFraction(counts, 0) - 0.92) < 1e-9);
  // A mid bin sits between the two.
  const mid = barTopFraction(counts, 1);
  assert.ok(mid > 0 && mid < 0.92);
});

test('tickStripSvg draws straight min/max ticks and an elbow for the median', () => {
  const svg = tickStripSvg(0.1, 0.3, 0.9);
  // min and max are straight vertical ticks at their mapped x.
  const xs = [...svg.matchAll(/<line x1="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(xs, [10, 90]);
  // The median routes down half, across to the centered label (x=50), then down.
  assert.match(svg, /<path d="M30 0 L30 5 L50 5 L50 10" fill="none"/);
  assert.match(svg, /viewBox="0 0 100 10"/);
  assert.match(svg, /vector-effect="non-scaling-stroke"/);
});

test('markerFraction maps a value onto the grid span and clamps', () => {
  const edges = [0, 2, 4];
  assert.equal(markerFraction(edges, 1), 0.25);
  assert.equal(markerFraction(edges, 2), 0.5);
  assert.equal(markerFraction(edges, 0), 0);
  assert.equal(markerFraction(edges, 4), 1);
  assert.equal(markerFraction(edges, 9), 1); // out of range clamps
  assert.equal(markerFraction([5, 5], 5), 0); // degenerate (zero-width) grid
});

test('binIndexAt maps a 0..1 fraction to a bin and clamps the edges', () => {
  assert.equal(binIndexAt(0, 4), 0);
  assert.equal(binIndexAt(0.49, 4), 1);
  assert.equal(binIndexAt(0.5, 4), 2);
  assert.equal(binIndexAt(0.99, 4), 3);
  // Out-of-range fractions clamp into the first/last bin.
  assert.equal(binIndexAt(-0.2, 4), 0);
  assert.equal(binIndexAt(1, 4), 3);
  assert.equal(binIndexAt(1.5, 4), 3);
});

test('histogramBin reads the edges and count for a bin off the nice grid', () => {
  const hist = { counts: [2, 7, 1, 0], edges: [0, 2, 4, 6, 8], min: 0.4, median: 3.1, max: 7.8 };
  assert.deepEqual(histogramBin(hist, 0), { lo: 0, hi: 2, count: 2 });
  assert.deepEqual(histogramBin(hist, 1), { lo: 2, hi: 4, count: 7 });
  assert.deepEqual(histogramBin(hist, 3), { lo: 6, hi: 8, count: 0 });
});
