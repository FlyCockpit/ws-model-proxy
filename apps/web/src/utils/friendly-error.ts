import {
  type DeletionConflictReason,
  isDeletionConflictReason,
} from "@ws-model-proxy/config/deletion-conflict";
// The default i18next instance, which `@/i18n` initializes for the app. Not
// imported from there, so this helper stays usable where that module is not
// loaded (tests that stub react-i18next).
import i18n from "i18next";

/**
 * Map an unknown error (oRPC ORPCError, Better Auth client error, fetch
 * error, thrown Error) to safe, localized user-facing copy (the `errors`
 * namespace, keyed by error code). Never returns `error.message` — that may
 * contain raw Prisma / auth.api / third-party SDK strings.
 *
 * Pass an optional `fallback` for context-specific copy ("Couldn't update
 * that user. Try again."), already translated. It is used only when we have
 * no specific code mapping; known codes (CONFLICT, FORBIDDEN, …) still return
 * their mapped copy.
 *
 * A structured deletion reason (oRPC `data.reason`, or a Better Auth user
 * deletion code) that does not depend on what was deleted gets its specific
 * copy. `retained_history` names the entity's own off switch, so it needs the
 * mutation's `deletionEntity` (see `deletionConflictMessageKey`); without one
 * it keeps the generic conflict copy.
 */
export function friendly(error: unknown, fallback?: string): string {
  const e = asErrorShape(error);
  const generic = fallback ?? i18n.t("errors:friendly.generic");

  if (!e) return generic;

  if (e.code === "TOO_MANY_REQUESTS" || e.status === 429) {
    const retryAfter = getRetryAfter(e);
    return retryAfter !== null
      ? i18n.t("errors:friendly.rateLimitedRetryAfter", { count: retryAfter })
      : i18n.t("errors:friendly.rateLimited");
  }

  const reason = deletionReasonOf(e);
  if (reason === "retained_history" && betterAuthDeletionReason(e.code) !== null) {
    // Better Auth's RETAINED_HISTORY only comes from deleting a user.
    return i18n.t("errors:deletionConflict.retainedHistory.user");
  }
  if (reason !== null && reason !== "retained_history") {
    return i18n.t(neutralDeletionConflictKey(reason));
  }

  if (e.code === "UNAUTHORIZED" || e.status === 401) {
    return i18n.t("errors:friendly.unauthorized");
  }
  if (e.code === "FORBIDDEN" || e.status === 403) {
    return i18n.t("errors:friendly.forbidden");
  }
  if (e.code === "NOT_FOUND" || e.status === 404) {
    return i18n.t("errors:friendly.notFound");
  }
  if (e.code === "CONFLICT" || e.status === 409) {
    return i18n.t("errors:friendly.conflict");
  }
  if (e.code === "BAD_REQUEST" || e.status === 400) {
    return i18n.t("errors:friendly.badRequest");
  }
  if (e.code === "INTERNAL_SERVER_ERROR" || (typeof e.status === "number" && e.status >= 500)) {
    return fallback ?? i18n.t("errors:friendly.serverError");
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
 * True if Better Auth refused the request because the account's deletion is
 * pending (`USER_DELETION_PENDING`: a 403 when a sign-in would mint a
 * session, a 409 on admin restore routes). Only reachable after the
 * credentials were accepted, so auth forms may show {@link friendly}'s
 * specific copy instead of a generic "invalid credentials".
 */
export function isUserDeletionPending(error: unknown): boolean {
  return asErrorShape(error)?.code === "USER_DELETION_PENDING";
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
  const e = asErrorShape(error);
  if (!e || !isConflict(error)) return null;
  return deletionReasonOf(e);
}

/**
 * Better Auth's delete and restore routes answer with their own `{ code,
 * message }` body, not an oRPC `data.reason`. These codes mean the same thing
 * as the dashboard's reasons, so they share its copy.
 */
const BETTER_AUTH_DELETION_REASONS: Readonly<Record<string, DeletionConflictReason>> = {
  USER_DELETION_PENDING: "deletion_in_progress",
  RETAINED_HISTORY: "retained_history",
};

function betterAuthDeletionReason(code: unknown): DeletionConflictReason | null {
  if (typeof code !== "string" || !Object.hasOwn(BETTER_AUTH_DELETION_REASONS, code)) return null;
  return BETTER_AUTH_DELETION_REASONS[code] ?? null;
}

/**
 * The deletion reason an error carries: an oRPC CONFLICT's `data.reason`, or
 * a Better Auth user-deletion code (a CONFLICT on delete / restore routes, a
 * FORBIDDEN on sign-in). Reads codes only, never the message.
 */
function deletionReasonOf(e: ErrorShape): DeletionConflictReason | null {
  const fromBetterAuth = betterAuthDeletionReason(e.code);
  if (fromBetterAuth) return fromBetterAuth;
  if (!(e.status === 409 || e.code === "CONFLICT")) return null;
  const data = e.data;
  if (!data || typeof data !== "object" || !("reason" in data)) return null;
  const reason = (data as { reason?: unknown }).reason;
  return isDeletionConflictReason(reason) ? reason : null;
}

function neutralDeletionConflictKey(
  reason: Exclude<DeletionConflictReason, "retained_history">,
): string {
  switch (reason) {
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
  if (reason === "retained_history") return `errors:deletionConflict.retainedHistory.${entity}`;
  return neutralDeletionConflictKey(reason);
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
