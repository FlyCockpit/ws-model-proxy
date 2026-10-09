/**
 * Who wrote something (`Actor` columns, audit rows), derived from the verified caller
 * (`Context.auth`), never from input. The one actor helper of every lane (B, C, D).
 *
 * Hardening (schema-hardening.sql): a row written by an agent names exactly one credential,
 * its agent token (`agentTokenId`) or its OAuth grant (`mcpGrantId`); a person's row names
 * neither.
 */
import { ORPCError } from "@orpc/server";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";

export type CallerActor = {
  actor: "USER" | "AGENT";
  actorUserId: string;
  agentTokenId: string | null;
  mcpGrantId: string | null;
};

/**
 * Defense in depth for writes: the MCP layer offers write tools only to FULL credentials, and a
 * procedure refuses a Read-only agent that reaches a write anyway.
 */
export function assertMayWrite(auth: CallerAuth | AnonymousAuth): void {
  if ((auth.kind === "agent_token" || auth.kind === "oauth_access_token") && auth.level !== "FULL")
    throw new ORPCError("FORBIDDEN", { message: "A Read-only agent cannot change anything." });
}

/**
 * The actor of a write. A cookie session without the verified CSRF header is neither a person
 * (`isHumanCaller`) nor an agent with a credential, so it may not write at all: recording it as
 * USER would show its writes as person-made to whoever reviews them.
 */
export function callerActor(auth: CallerAuth | AnonymousAuth, userId: string): CallerActor {
  assertMayWrite(auth);
  if (auth.kind === "agent_token")
    return {
      actor: "AGENT",
      actorUserId: userId,
      agentTokenId: auth.agentTokenId,
      mcpGrantId: null,
    };
  if (auth.kind === "oauth_access_token")
    return { actor: "AGENT", actorUserId: userId, agentTokenId: null, mcpGrantId: auth.grantId };
  if (auth.kind === "cookie_session" && auth.csrfVerified)
    return { actor: "USER", actorUserId: userId, agentTokenId: null, mcpGrantId: null };
  throw new ORPCError("FORBIDDEN", {
    message: "This change needs the web app's CSRF header or an agent token.",
  });
}
