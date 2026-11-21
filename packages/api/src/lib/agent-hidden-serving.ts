/**
 * Traffic, load and request rows an allowlisted agent must not see: those served on a hidden
 * node, or by an instance the shared hidden-instance predicate (`hiddenInstancesWhere` in
 * `agent-hidden-nodes.ts`) matches, whichever node served them. Kept apart from that module
 * so its row-level helpers stay free of the database client.
 */
import { Prisma } from "@ws-model-proxy/db";
import { hiddenInstancesWhere } from "./agent-hidden-nodes";

/** The serving columns of the tables these filters apply to (never caller input). */
type ServedColumn = '"nodeId"' | '"instanceId"' | 'l."nodeId"' | 'l."instanceId"';

/** Usage rollups (minute and hour) and request-family metrics. */
export const ROLLUP_SERVED = { node: '"nodeId"', instance: '"instanceId"' } as const;
/** `runtime_load_minute` aliased as `l`. */
export const LOAD_SERVED = { node: 'l."nodeId"', instance: 'l."instanceId"' } as const;

/**
 * Where traffic and load were served out of an allowlisted agent's sight: its hidden nodes,
 * and every instance the hidden-instance predicate matches (whichever node served the request).
 */
export type HiddenServing = {
  readonly nodeIds: readonly string[];
  readonly instanceIds: readonly string[];
};

export const NOTHING_HIDDEN: HiddenServing = { nodeIds: [], instanceIds: [] };

/**
 * Instances that may have served a request created at or after `since`: every one still in a
 * live phase, and the stopped or failed ones whose phase changed since. Every phase change sets
 * `phaseChangedAt` (`instancePhaseData`, and the node-delete trigger), so an instance that
 * stopped earlier served nothing in the window. Instance rows are kept until their runtime is
 * deleted; this keeps the lookup to the window's instances instead of every past start.
 */
export function servedSinceWhere(since: Date): Prisma.RuntimeInstanceWhereInput {
  return { OR: [{ phase: { notIn: ["STOPPED", "FAILED"] } }, { phaseChangedAt: { gte: since } }] };
}

/**
 * Resolve, once per read, the hidden instances that may have served the read's rows.
 * `createdSince` bounds the lookup only for reads of request rows by creation time (the
 * earliest `createdAt` the read can return): an instance serves a request it was live for when
 * the request was created, so one that stopped before then served none. Rollup and load reads
 * pass nothing: they are bucketed by completion, and a request can complete (or be finalized by
 * abandoned-request recovery) long after its instance stopped, so no window bounds them.
 * Nothing to look up without hidden nodes.
 */
export async function hiddenServing(
  db: Prisma.TransactionClient,
  nodeIds: readonly string[],
  createdSince?: Date,
): Promise<HiddenServing> {
  if (nodeIds.length === 0) return NOTHING_HIDDEN;
  const instances = await db.runtimeInstance.findMany({
    where:
      createdSince === undefined
        ? hiddenInstancesWhere(nodeIds)
        : { AND: [hiddenInstancesWhere(nodeIds), servedSinceWhere(createdSince)] },
    select: { id: true },
  });
  return { nodeIds: [...nodeIds], instanceIds: instances.map((instance) => instance.id) };
}

/**
 * The SQL conjuncts (each with a leading AND) that leave out traffic or load rows served on a
 * hidden node or by a hidden instance. Empty when nothing is hidden, so the query is unchanged.
 * Ids are bound parameters; the columns come only from the fixed list below.
 */
export function andServedVisibly(
  hidden: HiddenServing,
  columns: { readonly node: ServedColumn; readonly instance: ServedColumn },
): Prisma.Sql {
  if (hidden.nodeIds.length === 0 && hidden.instanceIds.length === 0) return Prisma.empty;
  const parts: Prisma.Sql[] = [];
  if (hidden.nodeIds.length > 0)
    parts.push(
      Prisma.sql` AND NOT (COALESCE(${Prisma.raw(columns.node)}, '') = ANY(${[...hidden.nodeIds]}::text[]))`,
    );
  if (hidden.instanceIds.length > 0)
    parts.push(
      Prisma.sql` AND NOT (COALESCE(${Prisma.raw(columns.instance)}, '') = ANY(${[...hidden.instanceIds]}::text[]))`,
    );
  return Prisma.join(parts, "");
}

/** The same exclusion for relay request rows (requests without a node or instance stay). */
export function servedVisiblyRequestWhere(hidden: HiddenServing): Prisma.RelayRequestWhereInput[] {
  return [
    ...(hidden.nodeIds.length > 0
      ? [{ OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: [...hidden.nodeIds] } }] }]
      : []),
    ...(hidden.instanceIds.length > 0
      ? [
          {
            OR: [
              { selectedInstanceId: null },
              { selectedInstanceId: { notIn: [...hidden.instanceIds] } },
            ],
          },
        ]
      : []),
  ];
}
