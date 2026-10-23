/**
 * The runtime definitions (versions) a node REQUIRES: what a process or step on it may still
 * name, so the server always sends them and only optional versions are ever dropped by the
 * node's cap (`RUNTIME_DEFINITIONS_MAX`, which the released CLI enforces):
 * - the launch version of every instance with a live claim (`LIVE_CLAIMS`) on the node;
 * - the version every unfinished step on the node names (`UNFINISHED_STEPS`);
 * - what each live-claimed rank on the node physically runs (its latest physical launch,
 *   `physicalLaunchIntents`): after a restart the earlier version, until its stop is proven.
 * Only the node owner's server-origin runtimes count (a node-origin definition lives in the
 * node's runtimes.json and takes no slot). Reservations add nothing: nothing is dispatched to
 * their nodes.
 *
 * One reader for the definition sync (`apps/server/src/relay/runtime-sync.ts`) and admission
 * (placement, `runtime_update` restarts), so what is refused is exactly what would not fit.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { LIVE_CLAIMS, physicalLaunchIntents } from "./instance-run";
import { stepIntentSchema } from "./step-intent";

type Db = Prisma.TransactionClient;

/** Steps that may still be dispatched or answered: the version they name must stay held. */
export const UNFINISHED_STEPS = ["PENDING", "RUNNING", "AWAITING_OPERATOR"] as const;

/**
 * Per node (every id of `nodeIds`, empty when it needs none), the version ids it requires.
 * A fixed number of queries whatever the number of nodes, ranks or steps. Callers that admit
 * (placement, restarts) run it under the owner's fence, in their transaction.
 */
export async function requiredDefinitionsByNode(
  db: Db,
  input: { userId: string; nodeIds: readonly string[] },
): Promise<Map<string, Set<string>>> {
  const { userId } = input;
  const nodeIds = [...new Set(input.nodeIds)];
  const required = new Map<string, Set<string>>(nodeIds.map((id) => [id, new Set<string>()]));
  if (nodeIds.length === 0) return required;
  const [ranks, steps] = await Promise.all([
    db.instanceRank.findMany({
      where: {
        nodeId: { in: nodeIds },
        claim: { in: [...LIVE_CLAIMS] },
        Instance: { userId },
      },
      select: { nodeId: true, Instance: { select: { launchVersionId: true } } },
    }),
    db.instanceStep.findMany({
      where: {
        nodeId: { in: nodeIds },
        state: { in: [...UNFINISHED_STEPS] },
        Instance: { userId },
      },
      select: { nodeId: true, intent: true },
    }),
  ]);
  // Only when some rank holds: the physical launches of live-claimed ranks, in one query.
  const physical = ranks.length > 0 ? await physicalLaunchIntents(db, { userId, nodeIds }) : [];

  // Candidate (node, version) pairs; versions are checked once below for owner and origin.
  const named: Array<{ nodeId: string; versionId: string }> = [];
  for (const rank of ranks)
    if (rank.nodeId) named.push({ nodeId: rank.nodeId, versionId: rank.Instance.launchVersionId });
  for (const row of [...steps, ...physical]) {
    const parsed = stepIntentSchema.safeParse(row.intent);
    if (parsed.success) named.push({ nodeId: row.nodeId, versionId: parsed.data.launchVersionId });
  }
  if (named.length === 0) return required;
  const counted = await db.runtimeVersion.findMany({
    where: {
      id: { in: [...new Set(named.map((entry) => entry.versionId))] },
      Runtime: { userId, origin: "SERVER" },
    },
    select: { id: true },
  });
  const server = new Set(counted.map((version) => version.id));
  for (const { nodeId, versionId } of named)
    if (server.has(versionId)) required.get(nodeId)?.add(versionId);
  return required;
}
