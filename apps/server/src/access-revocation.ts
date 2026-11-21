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
 * Narrowing aborts every MCP call and only node work outside the new access.
 */
import type { AccessRevokedEvent } from "@ws-model-proxy/api/context";
import { agentHasScope } from "@ws-model-proxy/auth/agent-scopes";
import type { AgentAccessNarrowedEvent } from "@ws-model-proxy/auth/mcp-grant-access";
import prisma from "@ws-model-proxy/db";
import {
  cancelFileOpsForNarrowedCredential,
  cancelFileOpsForToken,
} from "./relay/node-file-ops.js";

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

export type AgentAccessNarrowedDeps = {
  cancelMcpToolCalls(credentialId: string): number;
  endAgentWork(event: AgentAccessNarrowedEvent): Promise<void>;
};

export async function handleAgentAccessNarrowed(
  event: AgentAccessNarrowedEvent,
  deps: AgentAccessNarrowedDeps,
): Promise<void> {
  for (const id of narrowedCredentialIds(event)) deps.cancelMcpToolCalls(id);
  await deps.endAgentWork(event);
}

export function narrowedCredentialIds(event: AgentAccessNarrowedEvent): string[] {
  return event.agentTokenId ? [event.agentTokenId, event.grantId] : [event.grantId];
}

/** Cancels only work the new scope set / allowlist no longer permits. */
export async function endNarrowedAgentWork(event: AgentAccessNarrowedEvent): Promise<void> {
  const ids = narrowedCredentialIds(event);
  for (const id of ids) cancelFileOpsForNarrowedCredential(id, event.after);
  const commandsAllowed = agentHasScope(event.after, "commands");
  const nodeIds = event.after.nodeIds;
  if (!commandsAllowed || nodeIds !== null) {
    await prisma.queuedNodeCommand.updateMany({
      where: {
        userId: event.userId,
        state: "QUEUED",
        OR: [{ agentTokenId: { in: ids } }, { mcpGrantId: { in: ids } }],
        ...(commandsAllowed ? { nodeId: { notIn: [...(nodeIds ?? [])] } } : {}),
      },
      data: {
        state: "EXPIRED",
        decidedAt: new Date(),
        decidedBy: null,
        outcome: "credential_lowered",
      },
    });
  }
  const runtimesAllowed = agentHasScope(event.after, "runtimes");
  if (!runtimesAllowed || nodeIds !== null) {
    await prisma.claimReleaseRequest.updateMany({
      where: {
        userId: event.userId,
        state: "PENDING",
        OR: [{ agentTokenId: { in: ids } }, { mcpGrantId: { in: ids } }],
        ...(runtimesAllowed ? { Rank: { nodeId: { notIn: [...(nodeIds ?? [])] } } } : {}),
      },
      data: { state: "CLEARED", pendingRankId: null, decidedAt: new Date() },
    });
  }
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
