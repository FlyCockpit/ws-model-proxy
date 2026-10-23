/**
 * The admission check of the lifecycle engine's automatic restart (`retake`): the same planner
 * and budgets as a start (`PlacementPlanner` over `loadPlacementContext`), for the instance's
 * own needs: its ranks pinned to their nodes and ports, its reservations placed again by their
 * labels (their previous nodes first). Its claims were RELEASED while it backed off, so another
 * start may have taken that room meanwhile; retaking without this check would over-commit the
 * node. Callers hold the owner fence (every claim writer on the owner's nodes takes it), so the
 * check and the retake are one decision.
 */
import { PlacementPlanner, type PlacementRefusal, type PlannedStart } from "./placement";
import { loadPlacementContext } from "./placement-load";
import type { RuntimeLaunch } from "./runtime-spec";
import type { Tx } from "./runtime-store";

export type RetakeInstance = {
  id: string;
  userId: string;
  runtimeId: string;
  launchVersionId: string;
  startedBy: "USER" | "AGENT" | "SYSTEM";
  ranks: ReadonlyArray<{ rank: number; nodeId: string; port: number; distPort: number | null }>;
  /** The current plan's reservations (their nodes are preferred again). */
  reservations: ReadonlyArray<{ index: number; nodeId: string | null }>;
};

export type RetakePlan =
  | { ok: true; start: PlannedStart }
  | { ok: false; refusal: PlacementRefusal };

export async function planRetake(
  tx: Tx,
  instance: RetakeInstance,
  launch: RuntimeLaunch,
  now: Date,
): Promise<RetakePlan> {
  const planner = new PlacementPlanner(
    // An agent's instance keeps the agent's rules (Full-control nodes only for reservations).
    await loadPlacementContext(tx, {
      userId: instance.userId,
      agent: instance.startedBy === "AGENT",
      now,
    }),
  );
  // A node-origin runtime's version takes no definition slot on its node.
  const runtime = await tx.runtime.findFirst({
    where: { id: instance.runtimeId, userId: instance.userId },
    select: { origin: true },
  });
  const ranks = [...instance.ranks].sort((a, b) => a.rank - b.rank);
  const reservationNodeIds: Array<string | null> = [];
  for (const reservation of instance.reservations)
    reservationNodeIds[reservation.index] = reservation.nodeId;
  const result = planner.place({
    runtimeId: instance.runtimeId,
    versionId: instance.launchVersionId,
    launch,
    nodeIds: ranks.map((rank) => rank.nodeId),
    restart: {
      instanceId: instance.id,
      ports: ranks.map((rank) => rank.port),
      distPort: ranks[0]?.distPort ?? null,
      reservationNodeIds,
    },
    retake: true,
    checkFrozen: false,
    nodeOrigin: runtime?.origin === "NODE",
    // An automatic restart never stops another instance.
    preempt: false,
  });
  return result.ok ? { ok: true, start: result.start } : { ok: false, refusal: result.refusal };
}
