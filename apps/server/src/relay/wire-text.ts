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
