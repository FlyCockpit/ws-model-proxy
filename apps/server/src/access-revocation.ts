/**
 * `Context.services.onAccessRevoked`: a credential, grant or share was revoked and committed.
 * Live work it authorized ends now instead of at its next lookup:
 * - an API key: its realtime sessions close (1008). Plain `/v1` responses already streaming
 *   run to completion (there is no registry of in-flight HTTP requests): a known limit.
 * - an agent token or OAuth grant: its in-flight MCP tool calls are aborted (both ids of an
 *   agent token, which also has a grant; calls registering just after are aborted too), the
 *   commands it queued for a person expire, and the node commands and file ops it started are
 *   cancelled.
 * - a share: the grantee's realtime sessions are rechecked now (not at the next 60 s pass).
 * Browser terminals are opened by a signed-in person, never by an agent credential.
 *
 * `handleAccessLevelLowered`: an OAuth grant went from Full to Read-only and committed (Access →
 * Agents, or the person chose Read-only when approving the client again). Every later lookup
 * reads READ (`/mcp` reads the grant per request; node admissions and the command sweep require
 * a FULL grant), so only the work the Full level already started ends here: its in-flight write
 * tool calls (read calls go on), the node commands and file ops it started (agents reach nodes
 * only at Full) and the commands it queued for a person (`credential_lowered`). There is no
 * cached admission to drop: nothing caches a grant's level.
 */
import type { AccessLevelLoweredEvent, AccessRevokedEvent } from "@ws-model-proxy/api/context";
import prisma from "@ws-model-proxy/db";
import { cancelFileOpsForToken } from "./relay/node-file-ops.js";

export type EndAgentWorkInput = {
  userId: string;
  credentialIds: readonly string[];
  /** Recorded on the queued commands it expires (default `credential_revoked`). */
  outcome?: "credential_revoked" | "credential_lowered";
};

export type AccessRevocationDeps = {
  terminateRealtimeForApiKey(apiKeyId: string): void;
  cancelMcpToolCalls(credentialId: string): number;
  /** Recheck this person's realtime sessions now. */
  recheckRealtime(userId: string): Promise<void>;
  /** Expire queued commands and cancel running node commands of these agent credentials. */
  endAgentWork(input: EndAgentWorkInput): Promise<void>;
};

export type AccessLevelLoweredDeps = {
  /** Abort the grant's in-flight write tool calls (and writes still registering). */
  cancelMcpWriteToolCalls(grantId: string): number;
  endAgentWork(input: EndAgentWorkInput): Promise<void>;
};

export async function handleAccessLevelLowered(
  event: AccessLevelLoweredEvent,
  deps: AccessLevelLoweredDeps,
): Promise<void> {
  deps.cancelMcpWriteToolCalls(event.grantId);
  await deps.endAgentWork({
    userId: event.userId,
    credentialIds: [event.grantId],
    outcome: "credential_lowered",
  });
}

export async function handleAccessRevoked(
  event: AccessRevokedEvent,
  deps: AccessRevocationDeps,
): Promise<void> {
  switch (event.kind) {
    case "api_key":
      deps.terminateRealtimeForApiKey(event.apiKeyId);
      return;
    case "agent_token":
      deps.cancelMcpToolCalls(event.agentTokenId);
      deps.cancelMcpToolCalls(event.grantId);
      await deps.endAgentWork({
        userId: event.userId,
        credentialIds: [event.agentTokenId, event.grantId],
      });
      return;
    case "oauth_grant":
      deps.cancelMcpToolCalls(event.grantId);
      await deps.endAgentWork({ userId: event.userId, credentialIds: [event.grantId] });
      return;
    case "share":
      await deps.recheckRealtime(event.granteeUserId);
      return;
  }
}

/**
 * The agent credentials' in-flight node file ops end now (and admissions still reading for
 * them refuse), synchronously before anything awaits; their queued commands expire
 * (`credential_revoked`, or `credential_lowered` for a grant lowered to Read-only), and their
 * pending release requests are cleared. Their
 * running node commands are cancelled by the node command tracker
 * (`cancelNodeCommandsForCredentials`).
 */
export async function endAgentWork(input: EndAgentWorkInput): Promise<void> {
  const ids = [...input.credentialIds];
  for (const id of ids) cancelFileOpsForToken(id);
  await prisma.queuedNodeCommand.updateMany({
    where: {
      userId: input.userId,
      state: "QUEUED",
      OR: [{ agentTokenId: { in: ids } }, { mcpGrantId: { in: ids } }],
    },
    data: {
      state: "EXPIRED",
      decidedAt: new Date(),
      decidedBy: null,
      outcome: input.outcome ?? "credential_revoked",
    },
  });
  // Their release requests no longer speak for a working agent: a person can still release the
  // claim directly.
  await prisma.claimReleaseRequest.updateMany({
    where: {
      userId: input.userId,
      state: "PENDING",
      OR: [{ agentTokenId: { in: ids } }, { mcpGrantId: { in: ids } }],
    },
    data: { state: "CLEARED", pendingRankId: null, decidedAt: new Date() },
  });
}
