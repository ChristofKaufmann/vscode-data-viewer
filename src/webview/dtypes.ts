// Maps a column's coarse dtype "kind" (from pandasTable's Python) to a small
// glyph shown before the header name. Kept to letters and common BMP characters
// that live in the regular UI font, so they render consistently in the webview.
const DTYPE_GLYPHS: Record<string, string> = {
  numeric: '#',
  text: 'T',
  bool: 'B',
  datetime: 'D',
  timedelta: 'Δ',
  categorical: 'C',
  other: '·',
};

export function dtypeGlyph(kind: string): string {
  return DTYPE_GLYPHS[kind] ?? DTYPE_GLYPHS.other;
}
