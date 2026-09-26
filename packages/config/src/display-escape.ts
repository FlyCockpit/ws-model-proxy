/**
 * The one escaping policy for untrusted text shown for a human decision: the
 * supervised-command confirm screen (rendered by the CLI) and the web request
 * panel show the same characters as `\u{…}`.
 *
 * The code point list lives in `display-escape-vectors.json` next to this file
 * together with shared test vectors; `apps/cli/src/display_escape.rs` holds
 * the same list and both sides test against that file.
 */

/**
 * Inclusive code point ranges shown as `\u{<hex>}`: controls (except the line
 * feed), bidi embeddings/overrides/isolates, zero-width and invisible
 * characters, space look-alikes, lone surrogates, variation selectors, tag
 * characters, and invisible format controls.
 */
export const DISPLAY_ESCAPE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0009],
  [0x000b, 0x001f],
  [0x007f, 0x00a0],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x1680, 0x1680],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

export function needsDisplayEscape(codePoint: number): boolean {
  for (const [start, end] of DISPLAY_ESCAPE_RANGES) {
    if (codePoint < start) return false;
    if (codePoint <= end) return true;
  }
  return false;
}

/**
 * `text` with every listed code point shown as `\u{<lowercase hex>}`. Line
 * feeds stay; each surface lays out line breaks itself.
 */
export function escapeForDisplay(text: string): string {
  let out = "";
  // `for...of` walks code points; a lone surrogate comes through on its own.
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += needsDisplayEscape(codePoint) ? `\\u{${codePoint.toString(16)}}` : char;
  }
  return out;
}
