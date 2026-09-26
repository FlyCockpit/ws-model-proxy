/**
 * Text that crosses the relay wire. JavaScript strings may hold unpaired
 * UTF-16 surrogates; `JSON.stringify` writes them as `\ud800` escapes, which
 * the CLI (like any UTF-8 JSON reader) cannot turn into a string. Every
 * string the server sends to a CLI must therefore be well-formed Unicode.
 */

/** True when `value` has no unpaired surrogate. */
export function isWellFormedText(value: string): boolean {
  return value.isWellFormed();
}

/**
 * Length in Unicode code points ("characters" in the relay contract; the CLI
 * counts Rust `char`s, which are the same for well-formed text).
 */
export function characterCount(value: string): number {
  return [...value].length;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest prefix of `value` of at most `maxCharacters` code points that
 * ends on a grapheme boundary (never inside a surrogate pair, emoji sequence,
 * or combining sequence). Unpaired surrogates become U+FFFD first, so the
 * result is always well-formed.
 *
 * A non-empty `value` never becomes empty (for `maxCharacters >= 1`): when
 * its first grapheme alone is longer than the limit (a letter with a long
 * run of combining marks), the cut falls between code points instead. That
 * is still well-formed, since whole code points are kept, and keeps the start
 * of the text rather than dropping all of it.
 */
export function truncateCharacters(value: string, maxCharacters: number): string {
  const text = value.toWellFormed();
  if (characterCount(text) <= maxCharacters) return text;
  let kept = "";
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = characterCount(segment);
    if (count + size > maxCharacters) break;
    kept += segment;
    count += size;
  }
  if (kept === "") return [...text].slice(0, Math.max(0, maxCharacters)).join("");
  return kept;
}

export class RelayWireTextError extends Error {
  constructor() {
    super("Relay frame text is not well-formed Unicode.");
    this.name = "RelayWireTextError";
  }
}

/**
 * `JSON.stringify` for relay frames: refuses (throws `RelayWireTextError`)
 * instead of writing an unpaired surrogate in any key or string value.
 */
export function stringifyWellFormed(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (!isWellFormedText(key)) throw new RelayWireTextError();
    if (typeof item === "string" && !isWellFormedText(item)) throw new RelayWireTextError();
    return item;
  });
}
