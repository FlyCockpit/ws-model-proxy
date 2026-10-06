import { ORPCError } from "@orpc/server";
import { type AnonymousAuth, type CallerAuth, isHumanCaller } from "../contracts/auth-context";

export type CallerActor = {
  actor: "USER" | "AGENT";
  agentTokenId: string | null;
};

/** Who an audit or provenance row names for this caller. */
export function callerActor(auth: CallerAuth | AnonymousAuth): CallerActor {
  if (auth.kind === "agent_token") return { actor: "AGENT", agentTokenId: auth.agentTokenId };
  if (isHumanCaller(auth)) return { actor: "USER", agentTokenId: null };
  // OAuth connections, and a cookie whose CSRF check failed (not a verified person).
  return { actor: "AGENT", agentTokenId: null };
}

/**
 * Defense in depth for agent writes: the MCP layer offers write tools only to FULL tokens, and
 * a procedure refuses a READ token that reaches a write anyway.
 */
export function assertMayWrite(auth: CallerAuth | AnonymousAuth): void {
  if (
    (auth.kind === "agent_token" || auth.kind === "oauth_access_token") &&
    auth.level !== "FULL"
  ) {
    throw new ORPCError("FORBIDDEN", { message: "This agent connection is read-only." });
  }
}
