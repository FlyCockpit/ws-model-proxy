/**
 * JSON-safe serialization for MCP tool output (MCP plan Phase 4 module seam;
 * the descriptor-specific projectors and secret-key redactor land in
 * Phase 5).
 *
 * Phase 4 scope: the stable, structural conversions every Phase 5 projector
 * will rely on — `Date` as ISO strings and `bigint` as decimal strings —
 * plus recursive application over plain arrays/objects. Prisma `Decimal`
 * and byte arrays are deliberately NOT guessed here: the plan requires them
 * to cross the wire only through explicit safe projections (Phase 5
 * descriptors), so a structural guess now would be dead or wrong code.
 */

/** Convert one JSON-unsafe scalar kind; recurse through containers. */
export function toJsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toJsonSafe(entry);
    }
    return out;
  }
  return value;
}
