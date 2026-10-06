import { ORPCError } from "@orpc/server";
import type { RefusalReason } from "../contracts/refusals";

type RefusalCode = "CONFLICT" | "FORBIDDEN" | "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS";

/**
 * A refusal the web and MCP read by `data.reason` (`contracts/refusals.ts`). The message is
 * developer-written and may name ids, never caller free text.
 */
export function refuse(
  reason: RefusalReason,
  message: string,
  code: RefusalCode = "CONFLICT",
): ORPCError<RefusalCode, { reason: RefusalReason; subjectId: string | null }> {
  return new ORPCError(code, { message, data: { reason, subjectId: null } });
}

export function refuseAbout(
  reason: RefusalReason,
  subjectId: string,
  message: string,
  code: RefusalCode = "CONFLICT",
): ORPCError<RefusalCode, { reason: RefusalReason; subjectId: string | null }> {
  return new ORPCError(code, { message, data: { reason, subjectId } });
}

export function notFound(what: string): ORPCError<"NOT_FOUND", undefined> {
  return new ORPCError("NOT_FOUND", { message: `${what} not found.` });
}

/** Prisma P2002 / PostgreSQL 23505, read by code only (the db module is mocked in tests). */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  if (code === "P2002" || code === "23505") return true;
  const cause = Reflect.get(error, "cause");
  return !!cause && typeof cause === "object" && Reflect.get(cause, "originalCode") === "23505";
}
