// Maps a column's coarse dtype "kind" (from pandasTable's Python) to the header
// glyph. Most kinds use a codicon (the icon font VS Code ships, copied into
// dist/ by esbuild); timedelta uses a plain Δ and the fallback a middle dot.
export interface GlyphSpec {
  /** codicon name without the `codicon-` prefix, e.g. "symbol-numeric". */
  codicon?: string;
  /** Plain-text glyph, used when no codicon fits. */
  text?: string;
}

const DTYPE_GLYPHS: Record<string, GlyphSpec> = {
  numeric: { codicon: 'symbol-numeric' },
  text: { codicon: 'symbol-string' },
  bool: { codicon: 'symbol-boolean' },
  datetime: { codicon: 'clockface' },
  categorical: { codicon: 'symbol-misc' },
  timedelta: { text: 'Δ' },
  other: { text: '·' },
};

export function dtypeGlyph(kind: string): GlyphSpec {
  return DTYPE_GLYPHS[kind] ?? DTYPE_GLYPHS.other;
}
