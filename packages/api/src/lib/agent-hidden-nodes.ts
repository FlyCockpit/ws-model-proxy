import type { Prisma } from "@ws-model-proxy/db";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";

/** Only the caller's own nodes can be hidden; contributed hardware keeps its usual view. */
export async function hiddenNodeIds(
  db: Prisma.TransactionClient,
  auth: CallerAuth | AnonymousAuth,
): Promise<string[]> {
  if (
    (auth.kind !== "agent_token" && auth.kind !== "oauth_access_token") ||
    auth.access.nodeIds === null
  )
    return [];
  const allowed = new Set(auth.access.nodeIds);
  const owned = await db.node.findMany({ where: { userId: auth.userId }, select: { id: true } });
  return owned.filter((node) => !allowed.has(node.id)).map((node) => node.id);
}

/**
 * THE hidden-instance predicate: an instance (anyone's) whose bound runtime node, any rank or
 * any reservation names a hidden node. Everything an allowlisted agent reads about instances
 * goes through it (counts, rows, status, health, load, traffic, request rows), so a mixed
 * instance is hidden as a whole. `instanceVisible` is the same rule over rows already loaded.
 */
export function hiddenInstancesWhere(hidden: readonly string[]): Prisma.RuntimeInstanceWhereInput {
  return {
    OR: [
      { Runtime: { nodeId: { in: [...hidden] } } },
      { Ranks: { some: { nodeId: { in: [...hidden] } } } },
      { Reservations: { some: { nodeId: { in: [...hidden] } } } },
    ],
  };
}

/** No bound runtime node, rank or reservation may name a hidden node. */
export function visibleInstancesWhere(hidden: readonly string[]): Prisma.RuntimeInstanceWhereInput {
  return hidden.length ? { NOT: hiddenInstancesWhere(hidden) } : {};
}

export function instanceVisible(
  instance: {
    Ranks: readonly { nodeId: string | null }[];
    Reservations?: readonly { nodeId: string | null }[];
  },
  hidden: ReadonlySet<string>,
  runtimeNodeId: string | null,
): boolean {
  return (
    (runtimeNodeId === null || !hidden.has(runtimeNodeId)) &&
    [...instance.Ranks, ...(instance.Reservations ?? [])].every(
      (part) => part.nodeId === null || !hidden.has(part.nodeId),
    )
  );
}
