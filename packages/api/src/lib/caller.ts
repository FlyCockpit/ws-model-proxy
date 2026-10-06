import { ORPCError } from "@orpc/server";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";

export type CallerActor = {
  actor: "USER" | "AGENT";
  agentTokenId: string | null;
};

/** Who an audit or provenance row names for this caller. */
export function callerActor(auth: CallerAuth | AnonymousAuth): CallerActor {
  if (auth.kind === "agent_token") return { actor: "AGENT", agentTokenId: auth.agentTokenId };
  if (auth.kind === "oauth_access_token") return { actor: "AGENT", agentTokenId: null };
  return { actor: "USER", agentTokenId: null };
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
