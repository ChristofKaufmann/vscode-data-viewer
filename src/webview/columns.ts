// Pure column helpers shared by the table renderer. Kept free of DOM/global
// access so they can be unit-tested in plain Node.

export const MIN_COL_WIDTH = 40;
export const AUTO_MIN_COL_WIDTH = 50;
export const MAX_COL_WIDTH = 420;

// Headers render bold (font-weight 600), so they take more horizontal space
// than the same number of normal-weight body characters. The per-character
// width estimate is tuned for the body text, so we inflate the header's
// contribution to keep long headers from clipping.
export const HEADER_WIDTH_FACTOR = 1.15;

// Matches integers/decimals with an optional sign, decimal comma or point,
// and scientific notation — used to right-align numeric columns.
const NUMBER_PATTERN = /^-?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/;

/**
 * A column is numeric when it has at least one non-empty value and every
 * non-empty value parses as a number. Empty cells are ignored, and a column
 * with no values at all is not considered numeric.
 */
export function isNumericColumn(values: Iterable<string>): boolean {
  let nonEmptySeen = false;
  for (const value of values) {
    if (value !== '') {
      nonEmptySeen = true;
      if (!NUMBER_PATTERN.test(value.trim())) {
        return false;
      }
    }
  }
  return nonEmptySeen;
}

/**
 * Effective character width of the widest content in a column. The header is
 * weighted by HEADER_WIDTH_FACTOR because it renders bold; values count at
 * face value.
 */
export function maxChars(header: string, values: Iterable<string>): number {
  let longest = header.length * HEADER_WIDTH_FACTOR;
  for (const value of values) {
    if (value.length > longest) {
      longest = value.length;
    }
  }
  return longest;
}

/**
 * Auto-fit width for a column: ~8px per character plus cell padding, clamped
 * so empty columns stay clickable and very wide text columns stay usable.
 */
export function autoWidth(chars: number): number {
  return Math.min(MAX_COL_WIDTH, Math.max(AUTO_MIN_COL_WIDTH, chars * 8 + 18));
}

/** Width during an interactive drag — only the hard minimum is enforced. */
export function clampDragWidth(width: number): number {
  return Math.max(MIN_COL_WIDTH, width);
}

/**
 * Builds the class string for a header or body cell. Column 0 is always the
 * sticky DataFrame index; header cells additionally pin to the top corner.
 */
export function cellClass(base: string, col: { index: boolean; numeric: boolean }): string {
  let cls = base;
  if (col.numeric) {
    cls += ' num';
  }
  if (col.index) {
    cls += base.includes('head') ? ' indexcol corner' : ' indexcol';
  }
  return cls;
}
