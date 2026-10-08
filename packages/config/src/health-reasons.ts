/**
 * Why a health probe failed, as a node sends it in a failed health result's `detail` and the
 * server stores it (`RuntimeInstance.healthDetail`): the serving process is not confirmed (its
 * unit has no task left), nothing listens, the probe ran out of time, the request failed another
 * way, the health or status command said not healthy, or `http_<code>` (the readiness URL
 * answered another status).
 */
export const HEALTH_FAILURES = [
  "serving_unconfirmed",
  "connect_refused",
  "timeout",
  "unreachable",
  "command_failed",
  "status_not_running",
] as const;
export type HealthFailure = (typeof HEALTH_FAILURES)[number];

const HEALTH_HTTP_FAILURE = /^http_([1-5][0-9]{2})$/;

/** The status of an `http_<code>` reason, else null. */
export function healthHttpStatus(detail: string): string | null {
  return HEALTH_HTTP_FAILURE.exec(detail)?.[1] ?? null;
}

export function isHealthFailure(detail: string): detail is HealthFailure {
  return (HEALTH_FAILURES as readonly string[]).includes(detail);
}

/** A health result's `detail` when it is a known reason (a node may send others later). */
export function healthFailureDetail(detail: string | undefined): string | null {
  if (detail === undefined) return null;
  return isHealthFailure(detail) || healthHttpStatus(detail) !== null ? detail : null;
}
