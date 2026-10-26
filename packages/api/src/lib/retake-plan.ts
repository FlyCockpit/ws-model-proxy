/**
 * The admission check of the lifecycle engine's automatic restart (`retake`): the same planner
 * and budgets as a start (`PlacementPlanner` over `loadPlacementContext`), for the instance's
 * own needs: its ranks pinned to their nodes and ports, its reservations placed again by their
 * labels (their previous nodes first). Its claims were RELEASED while it backed off, so another
 * start may have taken that room meanwhile; retaking without this check would over-commit the
 * node. Callers hold the owner fence (every claim writer on the owner's nodes takes it), so the
 * check and the retake are one decision.
 *
 * An agent's instance restarts on the agent's rules (owner decision): every node the restart
 * reaches must be at Full control, as for the agent's own restart (`runtime_start` with the
 * instance id): its ranks, every reservation row still held, a replaced run's included, and the
 * reservation nodes a launch that may still run names (the leading STOP acts there). Otherwise it is refused (`trust_relay`) and waits like any refused
 * restart; a person may restart it.
 */
import { agentBlockedNodeWithCleanup, OCCUPANCY_SELECT } from "./instance-occupancy";
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
  if (instance.startedBy === "AGENT") {
    const occupancy = await tx.runtimeInstance.findFirst({
      where: { id: instance.id, userId: instance.userId },
      select: OCCUPANCY_SELECT,
    });
    const blocked = occupancy
      ? await agentBlockedNodeWithCleanup(tx, instance.userId, { id: instance.id, ...occupancy })
      : null;
    if (blocked)
      return {
        ok: false,
        refusal: {
          reason: "trust_relay",
          subjectId: blocked.nodeId ?? instance.id,
          message:
            "A node this agent-started instance holds is Relay only: agents cannot start or stop runtimes there. A person can restart it in the browser.",
        },
      };
  }
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
