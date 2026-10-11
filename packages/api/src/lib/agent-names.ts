/**
 * Display names of the agents that wrote activity rows: an agent token's name, or for an OAuth
 * client (rows that name `mcpGrantId`) the client's registered name. Two batched reads per page,
 * scoped to the caller's own tokens and grants.
 */
import prisma from "@ws-model-proxy/db";

export type AgentCredentialRef = { agentTokenId: string | null; mcpGrantId: string | null };

export async function loadAgentNames(
  userId: string,
  rows: readonly AgentCredentialRef[],
): Promise<(row: AgentCredentialRef) => string | null> {
  const tokenIds = [
    ...new Set(rows.flatMap((row) => (row.agentTokenId ? [row.agentTokenId] : []))),
  ];
  const grantIds = [...new Set(rows.flatMap((row) => (row.mcpGrantId ? [row.mcpGrantId] : [])))];
  const [tokens, grants] = await Promise.all([
    tokenIds.length
      ? prisma.agentToken.findMany({
          where: { id: { in: tokenIds }, userId },
          select: { id: true, name: true },
        })
      : [],
    grantIds.length
      ? prisma.mcpGrant.findMany({
          where: { id: { in: grantIds }, userId },
          select: { id: true, clientId: true },
        })
      : [],
  ]);
  const clientIds = [...new Set(grants.map((grant) => grant.clientId))];
  const clients = clientIds.length
    ? await prisma.oauthClient.findMany({
        where: { clientId: { in: clientIds } },
        select: { clientId: true, name: true },
      })
    : [];
  const tokenName = new Map(tokens.map((token) => [token.id, token.name]));
  const clientName = new Map(clients.map((client) => [client.clientId, client.name]));
  const grantName = new Map(
    grants.map((grant) => [grant.id, clientName.get(grant.clientId) ?? grant.clientId]),
  );
  return (row) =>
    (row.agentTokenId ? tokenName.get(row.agentTokenId) : undefined) ??
    (row.mcpGrantId ? grantName.get(row.mcpGrantId) : undefined) ??
    null;
}
