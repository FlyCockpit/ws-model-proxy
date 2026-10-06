/**
 * Who wrote something (`Actor` columns, audit rows) and the refusal error every lane-C
 * procedure throws. Derived from the verified caller (`Context.auth`), never from input.
 */
import { ORPCError } from "@orpc/server";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";
import type { RefusalReason } from "../contracts/refusals";

export type CallerActor = {
  actor: "USER" | "AGENT";
  actorUserId: string;
  /** Set for agent tokens only (OAuth grants have no token row). */
  agentTokenId: string | null;
};

export function callerActor(auth: CallerAuth | AnonymousAuth, userId: string): CallerActor {
  if (auth.kind === "agent_token")
    return { actor: "AGENT", actorUserId: userId, agentTokenId: auth.agentTokenId };
  if (auth.kind === "oauth_access_token")
    return { actor: "AGENT", actorUserId: userId, agentTokenId: null };
  return { actor: "USER", actorUserId: userId, agentTokenId: null };
}

/** HTTP-ish status for each refusal family (the reason is what callers read). */
const REFUSAL_STATUS: Partial<Record<RefusalReason, "FORBIDDEN" | "BAD_REQUEST" | "NOT_FOUND">> = {
  human_only: "FORBIDDEN",
  trust_relay: "FORBIDDEN",
  not_your_runtime: "FORBIDDEN",
  contribute_not_allowed: "FORBIDDEN",
  own_hardware_only: "FORBIDDEN",
  model_type_mismatch: "BAD_REQUEST",
  sidecar_chain: "BAD_REQUEST",
  unknown_node: "BAD_REQUEST",
  invalid_node_count: "BAD_REQUEST",
};

/** A refusal with `data.reason` (fixed, developer-written message; never caller text). */
export function refusal(reason: RefusalReason, message: string, subjectId: string | null = null) {
  return new ORPCError(REFUSAL_STATUS[reason] ?? "CONFLICT", {
    message,
    data: { reason, subjectId },
  });
}

export function notFound(what = "Not found") {
  return new ORPCError("NOT_FOUND", { message: what });
}

/** Prisma unique-violation (P2002) without importing the generated error classes. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/** Prisma foreign-key violation (P2003), e.g. a profile still pins a runtime. */
export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2003"
  );
}
