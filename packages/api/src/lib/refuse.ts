/**
 * Refusals and database-violation checks shared by every lane's procedures (B, C, D): the one
 * module for them (the actor of a write lives in ./caller-actor.ts).
 */
import { ORPCError } from "@orpc/server";
import type { RefusalReason } from "../contracts/refusals";

type RefusalCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "TOO_MANY_REQUESTS";

type RefusalError = ORPCError<RefusalCode, { reason: RefusalReason; subjectId: string | null }>;

/**
 * The message of every "nothing was written, retry" CONFLICT: a capacity-ordered or serializable
 * write that exhausted its deadlock / serialization retries or passed its server-side lock or
 * statement bound, and rolled back. Callers (and the PostgreSQL suites) retry on it.
 */
export const RETRY_CONFLICT_MESSAGE = "Configuration changed concurrently. Retry the request.";

/** Status for each refusal family when the caller does not choose one (the reason is what callers read). */
const REFUSAL_STATUS: Partial<Record<RefusalReason, RefusalCode>> = {
  human_only: "FORBIDDEN",
  trust_relay: "FORBIDDEN",
  not_your_runtime: "FORBIDDEN",
  contribute_not_allowed: "FORBIDDEN",
  own_hardware_only: "FORBIDDEN",
  model_type_mismatch: "BAD_REQUEST",
  sidecar_chain: "BAD_REQUEST",
  unknown_node: "BAD_REQUEST",
  invalid_node_count: "BAD_REQUEST",
  node_online: "CONFLICT",
  rate_limited: "TOO_MANY_REQUESTS",
};

/**
 * A refusal the web and MCP read by `data.reason` (`contracts/refusals.ts`). The message is
 * developer-written and may name ids, never caller free text.
 */
export function refuse(reason: RefusalReason, message: string, code?: RefusalCode): RefusalError {
  return new ORPCError(code ?? REFUSAL_STATUS[reason] ?? "CONFLICT", {
    message,
    data: { reason, subjectId: null },
  });
}

/** A refusal about one node, instance, member or other subject (`data.subjectId`). */
export function refuseAbout(
  reason: RefusalReason,
  subjectId: string | null,
  message: string,
  code?: RefusalCode,
): RefusalError {
  return new ORPCError(code ?? REFUSAL_STATUS[reason] ?? "CONFLICT", {
    message,
    data: { reason, subjectId },
  });
}

/** A missing (or not the caller's) row. `message` is a full sentence. */
export function notFound(message = "Not found."): ORPCError<"NOT_FOUND", undefined> {
  return new ORPCError("NOT_FOUND", { message });
}

/** Prisma P2002 / PostgreSQL 23505, read by code only (the db module is mocked in tests). */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  if (code === "P2002" || code === "23505") return true;
  const cause = Reflect.get(error, "cause");
  return !!cause && typeof cause === "object" && Reflect.get(cause, "originalCode") === "23505";
}

/**
 * A foreign-key violation (P2003 / 23503) anywhere in the error's cause chain: a profile still
 * pins a runtime, the RESTRICT from `runtime_instance.fabricId` on a fabric delete.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (code === "P2003" || code === "23503") return true;
    }
    for (const key of ["meta", "cause", "driverAdapterError"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

/** A CHECK, trigger or unique violation (23xxx / P0001 raised by a hardening trigger). */
export function isConstraintViolation(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  if (!error || typeof error !== "object") return false;
  const meta = Reflect.get(error, "meta");
  const metaCode = meta && typeof meta === "object" ? Reflect.get(meta, "code") : undefined;
  const cause = Reflect.get(error, "cause");
  const causeCode =
    cause && typeof cause === "object" ? Reflect.get(cause, "originalCode") : undefined;
  return [Reflect.get(error, "code"), metaCode, causeCode].some(
    (code) => typeof code === "string" && (/^23[0-9A-Z]{3}$/.test(code) || code === "P0001"),
  );
}
