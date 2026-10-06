/**
 * `Context.services.onAccessRevoked`: a credential, grant or share was revoked and committed.
 * Live work it authorized ends now instead of at its next lookup:
 * - an API key: its realtime sessions close (1008). Plain `/v1` responses already streaming
 *   run to completion (there is no registry of in-flight HTTP requests): a known limit.
 * - an agent token or OAuth grant: its in-flight MCP tool calls are aborted (both ids of an
 *   agent token, which also has a grant; calls registering just after are aborted too), the
 *   commands it queued for a person expire, and the node commands it started are cancelled.
 * - a share: the grantee's realtime sessions are rechecked now (not at the next 60 s pass).
 * Browser terminals are opened by a signed-in person, never by an agent credential.
 */
import type { AccessRevokedEvent } from "@ws-model-proxy/api/context";
import prisma from "@ws-model-proxy/db";

export type AccessRevocationDeps = {
  terminateRealtimeForApiKey(apiKeyId: string): void;
  cancelMcpToolCalls(credentialId: string): number;
  /** Recheck this person's realtime sessions now. */
  recheckRealtime(userId: string): Promise<void>;
  /** Expire queued commands and cancel running node commands of these agent credentials. */
  endAgentWork(input: { userId: string; credentialIds: readonly string[] }): Promise<void>;
};

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
 * The agent credentials' queued commands expire (`credential_revoked`). Their running node
 * commands are cancelled by the node command tracker (`cancelNodeCommandsForCredentials`).
 */
export async function endAgentWork(input: {
  userId: string;
  credentialIds: readonly string[];
}): Promise<void> {
  const ids = [...input.credentialIds];
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
      outcome: "credential_revoked",
    },
  });
}
