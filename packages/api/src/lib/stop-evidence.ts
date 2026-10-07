import type { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type { instanceRankViewSchema } from "../contracts/runtimes";

/**
 * What wsmp knows about a stop it could not confirm, for the person deciding whether to mark the
 * instance stopped: each rank's node connection and its last automatic stop check.
 */

type RankView = z.infer<typeof instanceRankViewSchema>;
export type StopCheck = NonNullable<RankView["lastStopCheck"]>;
export type NodeConnectionView = RankView["nodeConnection"];

/** A node session heartbeats at least this often; older means it is gone (as the lifecycle). */
const HEARTBEAT_STALE_MS = 3 * 60_000;

export function stopCheckKey(instanceId: string, rank: number): string {
  return `${instanceId}:${rank}`;
}

/**
 * A node's connection as the lifecycle judges it: an ONLINE row whose heartbeat went stale is
 * offline since that heartbeat (a server that stopped abruptly never wrote the disconnect).
 */
export function nodeConnectionView(
  node: {
    connection: "ONLINE" | "OFFLINE";
    lastConnectedAt: Date | null;
    lastDisconnectedAt: Date | null;
    lastHeartbeatAt: Date | null;
  } | null,
  now: Date = new Date(),
): NodeConnectionView {
  if (!node) return null;
  if (node.connection === "OFFLINE")
    return { state: "OFFLINE", since: node.lastDisconnectedAt?.toISOString() ?? null };
  if (node.lastHeartbeatAt && node.lastHeartbeatAt.getTime() < now.getTime() - HEARTBEAT_STALE_MS)
    return { state: "OFFLINE", since: node.lastHeartbeatAt.toISOString() };
  return { state: "ONLINE", since: node.lastConnectedAt?.toISOString() ?? null };
}

type StepReader = { instanceStep: { findFirst: Prisma.InstanceStepDelegate["findFirst"] } };

/**
 * The last finished status probe (automatic stop check) of each rank of the STOPPING instances
 * among `instances`, from this stop only (created since the instance began stopping): a check of
 * an earlier run says nothing about this one. One indexed lookup per rank.
 */
export async function latestStopChecks(
  db: StepReader,
  instances: ReadonlyArray<{
    id: string;
    phase: string;
    phaseChangedAt: Date;
    Ranks: ReadonlyArray<{ rank: number }>;
  }>,
): Promise<Map<string, StopCheck>> {
  const probes = await Promise.all(
    instances
      .filter((row) => row.phase === "STOPPING")
      .flatMap((row) =>
        row.Ranks.map(({ rank }) =>
          db.instanceStep.findFirst({
            where: {
              instanceId: row.id,
              rank,
              phase: "STATUS",
              state: { in: ["SUCCEEDED", "FAILED"] },
              createdAt: { gte: row.phaseChangedAt },
            },
            orderBy: { sequence: "desc" },
            select: { instanceId: true, rank: true, state: true, errorCode: true, updatedAt: true },
          }),
        ),
      ),
  );
  const checks = new Map<string, StopCheck>();
  for (const probe of probes)
    if (probe)
      checks.set(stopCheckKey(probe.instanceId, probe.rank), {
        at: probe.updatedAt.toISOString(),
        proven: probe.state === "SUCCEEDED",
        errorCode: probe.errorCode,
      });
  return checks;
}
