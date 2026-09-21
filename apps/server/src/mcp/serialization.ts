/**
 * JSON-safe serialization for MCP tool output (Phase 4 module seam;
 * completed in the tool-output implementation).
 *
 * Stable structural conversions applied AFTER descriptor-specific projections
 * and the defense-in-depth secret redactor:
 * - `Date` → ISO string;
 * - `bigint` → decimal string;
 * - Prisma `Decimal` (decimal.js) → decimal string (structural detection —
 *   see {@link isPrismaDecimalLike});
 * - byte arrays (`Uint8Array`, `Buffer`) → a fixed elision marker. Bytes may
 *   cross the wire ONLY through explicit safe projections;
 *   this arm is the fail-safe that silently-encoded bytes never leak, and a
 *   projection that wants bytes must decode them itself BEFORE this pass;
 * - functions → a fixed marker (a closure would capture server scope);
 * - recursion depth is bounded so cyclic structures cannot exhaust the stack
 *   (deeper values are replaced with a marker).
 */

/** Fixed markers for values that must never serialize their contents. */
export const MCP_BYTES_ELIDED = "[bytes-elided]";
export const MCP_MAX_DEPTH_ELIDED = "[max-depth-elided]";
export const MCP_FUNCTION_ELIDED = "[function-elided]";

/** Structural recursion bound; matches the redactor's bound. */
export const MAX_JSON_SAFE_DEPTH = 24;

/**
 * Structural detector for Prisma `Decimal` values (decimal.js instances).
 *
 * decimal.js instances carry the `d` (digits array), `e` (exponent number),
 * and `s` (sign number) internals plus the familiar numeric formatting
 * methods; no Prisma/JSON value we serialize shares that shape. Structural
 * detection (instead of importing the generated client) keeps this module
 * import-graph clean and testable without a database/env dependency, and
 * `String(value)` is decimal.js's canonical decimal representation.
 *
 * The guard's declared type lists the internals so a plain `object` is NOT
 * absorbed by the positive branch (which would narrow everything else to
 * `never`).
 */
export interface PrismaDecimalShape {
  readonly d: readonly number[];
  readonly e: number;
  readonly s: number;
  toString(): string;
}

export function isPrismaDecimalLike(value: unknown): value is PrismaDecimalShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.d) &&
    typeof candidate.e === "number" &&
    typeof candidate.s === "number" &&
    typeof candidate.toFixed === "function" &&
    typeof candidate.toSignificantDigits === "function"
  );
}

/** Convert one JSON-unsafe scalar kind; recurse (bounded) through containers. */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_SAFE_DEPTH) return MCP_MAX_DEPTH_ELIDED;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return MCP_FUNCTION_ELIDED;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => toJsonSafe(entry, depth + 1));
  // Byte arrays BEFORE the generic object arm: Uint8Array subclasses
  // (Buffer) and views must never serialize their contents here.
  if (value instanceof Uint8Array) return MCP_BYTES_ELIDED;
  if (isPrismaDecimalLike(value)) return String(value);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toJsonSafe(entry, depth + 1);
    }
    return out;
  }
  return null;
}
