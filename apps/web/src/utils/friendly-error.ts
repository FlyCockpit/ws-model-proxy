import {
  type DeletionConflictReason,
  isDeletionConflictReason,
} from "@ws-model-proxy/config/deletion-conflict";

/**
 * Map an unknown error (oRPC ORPCError, fetch error, thrown Error) to safe
 * user-facing copy. Never returns `error.message` — that may contain raw
 * Prisma / auth.api / third-party SDK strings.
 *
 * Pass an optional `fallback` for context-specific copy ("Couldn't update
 * that user. Try again."). It is used only when we have no specific code
 * mapping; known codes (CONFLICT, FORBIDDEN, …) still return their mapped
 * copy.
 */
export function friendly(error: unknown, fallback?: string): string {
  const e = asErrorShape(error);
  const generic = fallback ?? "Something didn't work. Try again.";

  if (!e) return generic;

  if (e.code === "TOO_MANY_REQUESTS" || e.status === 429) {
    const retryAfter = getRetryAfter(e);
    return retryAfter !== null
      ? `Too many attempts. Try again in ${retryAfter} seconds.`
      : "Too many attempts. Please wait a few minutes and try again.";
  }

  if (e.code === "UNAUTHORIZED" || e.status === 401) {
    return "Your session has ended. Sign in again.";
  }
  if (e.code === "FORBIDDEN" || e.status === 403) {
    return "You don't have access to this.";
  }
  if (e.code === "NOT_FOUND" || e.status === 404) {
    return "That wasn't found.";
  }
  if (e.code === "CONFLICT" || e.status === 409) {
    return "That conflicts with an existing record.";
  }
  if (e.code === "BAD_REQUEST" || e.status === 400) {
    return "That request wasn't valid.";
  }
  if (e.code === "INTERNAL_SERVER_ERROR" || (typeof e.status === "number" && e.status >= 500)) {
    return fallback ?? "Something didn't work on our end. Try again in a moment.";
  }

  return generic;
}

/**
 * True if the error looks like a 429 / TOO_MANY_REQUESTS response from oRPC.
 */
export function isRateLimit(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 429 || e.code === "TOO_MANY_REQUESTS";
}

/**
 * True if the error looks like a 409 / CONFLICT response from oRPC — e.g. an
 * active-token cap or a duplicate record.
 */
export function isConflict(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 409 || e.code === "CONFLICT";
}

/**
 * The structured reason (`data.reason`) the API attaches to a
 * deletion-related CONFLICT, or null for any other error — including a
 * CONFLICT without a known reason. Reads only the code, never the message.
 */
export function deletionConflictReason(error: unknown): DeletionConflictReason | null {
  if (!isConflict(error)) return null;
  const data = asErrorShape(error)?.data;
  if (!data || typeof data !== "object" || !("reason" in data)) return null;
  const reason = (data as { reason?: unknown }).reason;
  return isDeletionConflictReason(reason) ? reason : null;
}

/** What a delete mutation removes; picks the "do this instead" copy. */
export type DeletionEntity =
  | "user"
  | "cliDevice"
  | "endpoint"
  | "discoveredModel"
  | "pool"
  | "poolMember"
  | "capacity";

/**
 * i18n key (errors namespace) for a deletion-related CONFLICT on `entity`, or
 * null when the error carries no known deletion reason (callers then fall
 * back to the generic `friendly()` copy). Retained history names the
 * entity's real off switch; the other reasons share entity-neutral copy.
 */
export function deletionConflictMessageKey(error: unknown, entity: DeletionEntity): string | null {
  const reason = deletionConflictReason(error);
  if (!reason) return null;
  switch (reason) {
    case "retained_history":
      return `errors:deletionConflict.retainedHistory.${entity}`;
    case "delete_pending":
      return "errors:deletionConflict.deletePending";
    case "delete_contended":
      return "errors:deletionConflict.deleteContended";
    case "still_attached":
      return "errors:deletionConflict.stillAttached";
    case "not_stale":
      return "errors:deletionConflict.notStale";
    case "deletion_in_progress":
      return "errors:deletionConflict.deletionInProgress";
  }
}

/** True if the error looks like a 404 / NOT_FOUND response from oRPC. */
export function isNotFound(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 404 || e.code === "NOT_FOUND";
}

/**
 * True if the error looks like a 403 / FORBIDDEN response from oRPC — e.g. a
 * policy that flipped server-side after the page loaded.
 */
export function isForbidden(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 403 || e.code === "FORBIDDEN";
}

/**
 * True if the error looks like a 400 / BAD_REQUEST response from oRPC — e.g.
 * a field-level schema rejection on the submitted input.
 */
export function isBadRequest(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 400 || e.code === "BAD_REQUEST";
}

type ErrorShape = {
  status?: number;
  code?: string;
  data?: unknown;
  cause?: unknown;
  message?: string;
};

function asErrorShape(error: unknown): ErrorShape | null {
  if (!error || typeof error !== "object") return null;
  return error as ErrorShape;
}

function getRetryAfter(e: ErrorShape): number | null {
  const fromData =
    e.data && typeof e.data === "object" && "retryAfter" in e.data
      ? (e.data as { retryAfter?: unknown }).retryAfter
      : undefined;
  const fromCause =
    e.cause && typeof e.cause === "object" && "retryAfter" in e.cause
      ? (e.cause as { retryAfter?: unknown }).retryAfter
      : undefined;
  const raw = fromData ?? fromCause;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
