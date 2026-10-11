/**
 * Canonical JSON for hashes the server and the node must agree on (relay 3.0 `launchHash`,
 * node metric commands hash). Rust mirror: `apps/cli/src/protocol/canonical.rs`. Shared
 * vectors: `apps/cli/tests/fixtures/relay-3.0/canonical/vectors.json`.
 *
 * Rules:
 * - object keys sorted by Unicode code point (= UTF-8 byte order; NOT UTF-16 order), no
 *   whitespace anywhere; `undefined` object members are omitted;
 * - strings escaped exactly as `JSON.stringify` does (`"`, `\`, and U+0000–U+001F only; the
 *   short forms `\b \t \n \f \r`, otherwise `\u00xx` lower-case); lone surrogates are refused;
 * - integers within ±(2^53 − 1) are written as decimal integers (`2.0` is `2`, `-0` is `0`);
 *   other numbers must be finite with 1e-6 ≤ |x| < 1e15 and are written in their shortest
 *   round-trip decimal form without an exponent; anything else is refused.
 *
 * Pure module (no Node built-ins). Hashing lives in `runtime-launch-hash.ts`.
 */

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalJsonError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Compares by Unicode code point, which equals UTF-8 byte order. */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError("Non-finite number", path);
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError("Unsafe integer", path);
    return Object.is(value, -0) ? "0" : String(value);
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1e-6 || magnitude >= 1e15)
    throw new CanonicalJsonError("Number outside the canonical range", path);
  return String(value);
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(canonicalNumber(value, path));
      return;
    case "string":
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError("Lone surrogate", path);
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item, index) => {
          if (index > 0) out.push(",");
          if (item === undefined)
            throw new CanonicalJsonError("Undefined array item", `${path}[${index}]`);
          write(item, `${path}[${index}]`, out);
        });
        out.push("]");
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new CanonicalJsonError("Only plain objects", path);
      const entries = Object.entries(value).filter(([, member]) => member !== undefined);
      entries.sort(([left], [right]) => compareCodePoints(left, right));
      out.push("{");
      entries.forEach(([key, member], index) => {
        if (index > 0) out.push(",");
        if (LONE_SURROGATE.test(key)) throw new CanonicalJsonError("Lone surrogate key", path);
        out.push(JSON.stringify(key), ":");
        write(member, `${path}.${key}`, out);
      });
      out.push("}");
      return;
    }
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value}`, path);
  }
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, "", out);
  return out.join("");
}
