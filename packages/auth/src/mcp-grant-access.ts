/** Grant access is shared by OAuth and personal tokens; only a person changes it. */
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { APIError } from "better-auth/api";
import { type AgentAccess, accessNarrowed, agentScopeFromDb, agentScopeToDb } from "./agent-scopes";
import { hasLiveCredentialSession } from "./credential-session";

export const MCP_GRANT_ACCESS_AUDIT = {
  consent: "mcp_grant.consent",
  access: "mcp_grant.access",
} as const;
export const mcpGrantAccessSelect = {
  scopes: true,
  allNodes: true,
  Nodes: { select: { nodeId: true } },
} as const satisfies Prisma.McpGrantSelect;
type AccessRow = Prisma.McpGrantGetPayload<{ select: typeof mcpGrantAccessSelect }>;
export function mcpGrantAccessOf(row: AccessRow): AgentAccess {
  return {
    scopes: row.scopes.map(agentScopeFromDb),
    nodeIds: row.allNodes ? null : row.Nodes.map((node) => node.nodeId),
  };
}
export async function readMcpGrantAccess(
  db: Pick<Prisma.TransactionClient, "mcpGrant">,
  grantId: string,
): Promise<AgentAccess | null> {
  const row = await db.mcpGrant.findFirst({
    where: { id: grantId, revokedAt: null },
    select: mcpGrantAccessSelect,
  });
  return row ? mcpGrantAccessOf(row) : null;
}
/** This check runs in the same transaction as the access write. */
export async function assertOwnedAgentNodes(
  tx: Prisma.TransactionClient,
  userId: string,
  nodeIds: readonly string[] | null,
): Promise<void> {
  if (nodeIds === null || nodeIds.length === 0) return;
  const ids = [...new Set(nodeIds)];
  const rows = await tx.node.findMany({ where: { userId, id: { in: ids } }, select: { id: true } });
  if (rows.length !== ids.length) throw new Error("One or more selected nodes do not exist.");
}
function jsonAccess(access: AgentAccess) {
  return {
    scopes: [...access.scopes],
    nodeIds: access.nodeIds === null ? null : [...access.nodeIds],
  };
}
async function auditAccess(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    grantId: string;
    action: string;
    before: AgentAccess | null;
    after: AgentAccess;
  },
) {
  await tx.auditEvent.create({
    data: {
      userId: input.userId,
      actor: "USER",
      actorUserId: input.userId,
      action: input.action,
      resourceType: "mcp_grant",
      resourceId: input.grantId,
      before: input.before === null ? undefined : jsonAccess(input.before),
      after: jsonAccess(input.after),
    },
  });
}
function sameAccess(a: AgentAccess, b: AgentAccess): boolean {
  return !accessNarrowed(a, b) && !accessNarrowed(b, a);
}
export type McpGrantAccessChange = {
  grantId: string;
  before: AgentAccess | null;
  after: AgentAccess;
  narrowed: boolean;
};
export async function setActiveMcpGrantAccess(
  tx: Prisma.TransactionClient,
  input: {
    grantId: string;
    userId: string;
    expected: AgentAccess;
    access: AgentAccess;
    action: string;
  },
): Promise<McpGrantAccessChange | null> {
  if (!input.access.scopes.includes("read")) throw new Error("Agent access requires read.");
  await assertOwnedAgentNodes(tx, input.userId, input.access.nodeIds);
  // Compare the complete snapshot, including node rows. Serializable isolation makes a
  // concurrent node/access write conflict, even when only the allowlist changes.
  const access: AgentAccess = {
    scopes: [...new Set(input.access.scopes)],
    nodeIds: input.access.nodeIds === null ? null : [...new Set(input.access.nodeIds)],
  };
  const row = await tx.mcpGrant.findFirst({
    where: { id: input.grantId, userId: input.userId, revokedAt: null },
    select: mcpGrantAccessSelect,
  });
  if (!row || !sameAccess(mcpGrantAccessOf(row), input.expected)) return null;
  if (sameAccess(input.expected, input.access))
    return { grantId: input.grantId, before: input.expected, after: access, narrowed: false };
  const updated = await tx.mcpGrant.updateMany({
    where: {
      id: input.grantId,
      userId: input.userId,
      revokedAt: null,
      scopes: { equals: row.scopes },
      allNodes: row.allNodes,
    },
    data: {
      scopes: [...new Set(input.access.scopes)].map(agentScopeToDb),
      allNodes: input.access.nodeIds === null,
    },
  });
  if (updated.count !== 1) return null;
  await tx.mcpGrantNode.deleteMany({ where: { grantId: input.grantId } });
  if (input.access.nodeIds?.length)
    await tx.mcpGrantNode.createMany({
      data: [...new Set(input.access.nodeIds)].map((nodeId) => ({
        grantId: input.grantId,
        userId: input.userId,
        nodeId,
      })),
    });
  await auditAccess(tx, { ...input, before: input.expected, after: access });
  return {
    grantId: input.grantId,
    before: input.expected,
    after: access,
    narrowed: accessNarrowed(input.expected, input.access),
  };
}
export type AgentAccessNarrowedEvent = {
  kind: "oauth_grant" | "agent_token";
  userId: string;
  grantId: string;
  agentTokenId: string | null;
  before: AgentAccess;
  after: AgentAccess;
};
type Listener = (event: AgentAccessNarrowedEvent) => void | Promise<void>;
const listeners = new Set<Listener>();
export function onMcpGrantAccessNarrowed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function notifyMcpGrantAccessNarrowed(event: AgentAccessNarrowedEvent): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(event);
    } catch (error) {
      console.error(
        "[auth] grant access narrowed listener failed",
        error instanceof Error ? error.constructor.name : typeof error,
      );
    }
  }
}
export async function recordConsentedMcpGrantAccess(input: {
  userId: string;
  sessionId: string;
  clientId: string;
  referenceId: string;
  scopes: AgentAccess["scopes"];
  nodeIds: AgentAccess["nodeIds"];
}): Promise<McpGrantAccessChange | null> {
  const access: AgentAccess = { scopes: input.scopes, nodeIds: input.nodeIds };
  if (!access.scopes.includes("read")) throw new Error("Agent access requires read.");
  const attempt = () =>
    runCapacityOrderedTransaction(
      prisma,
      async (tx): Promise<McpGrantAccessChange | "tombstone" | "conflict"> => {
        await fenceOwners(tx, [input.userId]);
        if (!(await hasLiveCredentialSession(tx, input.userId, input.sessionId)))
          throw new APIError("UNAUTHORIZED", { message: "A live session is required." });
        await assertOwnedAgentNodes(tx, input.userId, access.nodeIds);
        const inserted = await tx.mcpGrant.createMany({
          data: [
            {
              userId: input.userId,
              clientId: input.clientId,
              referenceId: input.referenceId,
              scopes: [...access.scopes].map(agentScopeToDb),
              allNodes: access.nodeIds === null,
            },
          ],
          skipDuplicates: true,
        });
        const row = await tx.mcpGrant.findUnique({
          where: {
            userId_clientId_referenceId: {
              userId: input.userId,
              clientId: input.clientId,
              referenceId: input.referenceId,
            },
          },
          select: { id: true, revokedAt: true, ...mcpGrantAccessSelect },
        });
        if (!row) return "conflict";
        if (row.revokedAt) return "tombstone";
        if (inserted.count === 1) {
          if (access.nodeIds?.length)
            await tx.mcpGrantNode.createMany({
              data: [...new Set(access.nodeIds)].map((nodeId) => ({
                grantId: row.id,
                userId: input.userId,
                nodeId,
              })),
            });
          await auditAccess(tx, {
            userId: input.userId,
            grantId: row.id,
            action: MCP_GRANT_ACCESS_AUDIT.consent,
            before: null,
            after: access,
          });
          return { grantId: row.id, before: null, after: access, narrowed: false };
        }
        return (
          (await setActiveMcpGrantAccess(tx, {
            userId: input.userId,
            grantId: row.id,
            expected: mcpGrantAccessOf(row),
            access,
            action: MCP_GRANT_ACCESS_AUDIT.consent,
          })) ?? "conflict"
        );
      },
    );
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    const result = await attempt();
    if (result === "conflict") continue;
    if (result === "tombstone") return null;
    if (result.narrowed && result.before)
      await notifyMcpGrantAccessNarrowed({
        kind: "oauth_grant",
        userId: input.userId,
        grantId: result.grantId,
        agentTokenId: null,
        before: result.before,
        after: result.after,
      });
    return result;
  }
  throw new Error("MCP grant access changed concurrently");
}
