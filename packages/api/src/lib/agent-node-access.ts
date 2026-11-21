/** Node authority is always ownership plus the credential allowlist, even through shared pools. */
import type { Prisma } from "@ws-model-proxy/db";
import { agentNodeAllowed } from "../contracts/agent-scopes";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";
import { isAgentCaller } from "../contracts/auth-context";
import { assertAgentNode } from "./caller-actor";
import {
  launchCleanupNodes,
  OCCUPANCY_SELECT,
  type OccupancyRow,
  occupiedNodes,
} from "./instance-occupancy";
import { notFound } from "./refuse";

type Auth = CallerAuth | AnonymousAuth;
export function agentNodeFilter(auth: Auth): { id: { in: string[] } } | Record<string, never> {
  return (auth.kind === "agent_token" || auth.kind === "oauth_access_token") &&
    auth.access.nodeIds !== null
    ? { id: { in: [...auth.access.nodeIds] } }
    : {};
}
export function nodeVisibleToAgent(auth: Auth, nodeId: string): boolean {
  return (
    (auth.kind !== "agent_token" && auth.kind !== "oauth_access_token") ||
    agentNodeAllowed(auth.access, nodeId)
  );
}
export async function assertAgentOwnedNodes(
  db: Prisma.TransactionClient,
  auth: Auth,
  nodeIds: readonly string[],
  message = "That node does not exist.",
): Promise<void> {
  if (!isAgentCaller(auth)) return;
  const ids = [...new Set(nodeIds)];
  for (const id of ids) assertAgentNode(auth, id, message);
  if (!ids.length || auth.kind === "anonymous") return;
  const owned = await db.node.findMany({
    where: { userId: auth.userId, id: { in: ids } },
    select: { id: true },
  });
  if (owned.length !== ids.length) throw notFound(message);
}
export async function assertAgentInstanceNodes(
  db: Prisma.TransactionClient,
  auth: Auth,
  userId: string,
  instance: OccupancyRow & { id: string },
  message = "That instance does not exist.",
): Promise<void> {
  if (!isAgentCaller(auth)) return;
  const cleanup = await launchCleanupNodes(db, userId, instance);
  if (auth.kind !== "agent_token" && auth.kind !== "oauth_access_token") return;
  const entries = [
    ...occupiedNodes(instance, "current"),
    ...occupiedNodes(instance, "holding"),
    ...cleanup,
  ];
  for (const entry of entries) {
    if (entry.nodeId) {
      assertAgentNode(auth, entry.nodeId, message);
      // A deleted node a live launch still names (offline-node recovery) has no row: it is
      // never in an allowlist (refused above), and a null allowlist keeps its old behavior.
      if (entry.node && entry.node.userId !== userId) throw notFound(message);
    }
  }
}
/** Bound nodes and all current/running placements must be within an agent's authority. */
export async function assertAgentRuntimeNodes(
  db: Prisma.TransactionClient,
  auth: Auth,
  userId: string,
  runtimeId: string,
): Promise<void> {
  if (!isAgentCaller(auth)) return;
  const runtime = await db.runtime.findFirst({
    where: { id: runtimeId, userId },
    select: {
      nodeId: true,
      Node: { select: { id: true, userId: true } },
      Instances: {
        where: {
          OR: [{ desiredState: "RUNNING" }, { Ranks: { some: { claim: { not: "RELEASED" } } } }],
        },
        select: { id: true, ...OCCUPANCY_SELECT },
      },
    },
  });
  if (!runtime) throw notFound("That runtime does not exist.");
  if (runtime.nodeId && (auth.kind === "agent_token" || auth.kind === "oauth_access_token")) {
    assertAgentNode(auth, runtime.nodeId, "That runtime does not exist.");
    if (runtime.Node?.userId !== userId) throw notFound("That runtime does not exist.");
  }
  for (const instance of runtime.Instances ?? [])
    await assertAgentInstanceNodes(db, auth, userId, instance, "That runtime does not exist.");
}
