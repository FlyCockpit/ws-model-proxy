// Request root is depth 0; every property/array entry adds one level.
// This acceptance bound also protects Node 24's recursive JSON serializers.
export const MAX_REQUEST_JSON_DEPTH = 256;

export const REQUEST_JSON_DEPTH_ERROR = `request JSON nesting exceeds ${MAX_REQUEST_JSON_DEPTH} levels`;

/** Parallel stacks retain only containers: no copies or wrappers per scalar. */
export function requestJsonDepthExceeded(
  value: unknown,
  maximumDepth = MAX_REQUEST_JSON_DEPTH,
  visit?: () => void,
): boolean {
  const containers: object[] = [];
  const depths: number[] = [];
  const inspect = (entry: unknown, depth: number): boolean => {
    visit?.();
    if (depth > maximumDepth) return true;
    if (entry !== null && typeof entry === "object") {
      containers.push(entry);
      depths.push(depth);
    }
    return false;
  };
  if (inspect(value, 0)) return true;
  while (containers.length) {
    const entry = containers.pop()!;
    const depth = depths.pop()! + 1;
    if (Array.isArray(entry)) {
      for (let i = 0; i < entry.length; i++) {
        if (inspect(entry[i], depth)) return true;
      }
    } else {
      for (const key in entry) {
        if (Object.hasOwn(entry, key) && inspect((entry as Record<string, unknown>)[key], depth))
          return true;
      }
    }
  }
  return false;
}
