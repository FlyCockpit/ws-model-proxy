const MAX_RETRIES = 3;

const transientCodes = new Set([
  "REQUEST_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "NETWORK_ERROR",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function statusFrom(error: unknown, seen = new Set<unknown>()): number | undefined {
  const value = record(error);
  if (!value || seen.has(error)) return undefined;
  seen.add(error);

  if (typeof value.status === "number") return value.status;
  const response = record(value.response);
  if (response && typeof response.status === "number") return response.status;
  return statusFrom(value.cause, seen);
}

function transientCodeFrom(error: unknown, seen = new Set<unknown>()): boolean {
  const value = record(error);
  if (!value || seen.has(error)) return false;
  seen.add(error);
  if (typeof value.code === "string" && transientCodes.has(value.code)) return true;
  // Fetch rejects transport failures with a TypeError and oRPC's fetch adapter
  // passes that rejection through. Avoid message matching because browser copy varies.
  if (value.name === "TypeError") return true;
  return transientCodeFrom(value.cause, seen);
}

/** TanStack Query retry policy. It classifies only; the original error is untouched. */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
  server = typeof window === "undefined",
): boolean {
  if (server || failureCount >= MAX_RETRIES) return false;

  const status = statusFrom(error);
  if (status !== undefined) return status === 408 || status >= 500;

  return transientCodeFrom(error);
}
