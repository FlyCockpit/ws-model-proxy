// Request root is depth 0; every property/array entry adds one level.
// This acceptance bound also protects Node 24's recursive JSON serializers.
export const MAX_REQUEST_JSON_DEPTH = 256;

export const REQUEST_JSON_DEPTH_ERROR = `request JSON nesting exceeds ${MAX_REQUEST_JSON_DEPTH} levels`;

export function requestJsonDepthExceeded(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > MAX_REQUEST_JSON_DEPTH) return true;
    if (entry.value !== null && typeof entry.value === "object") {
      for (const value of Object.values(entry.value)) {
        pending.push({ value, depth: entry.depth + 1 });
      }
    }
  }
  return false;
}
