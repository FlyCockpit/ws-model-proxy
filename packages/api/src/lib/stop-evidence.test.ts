import { describe, expect, it, vi } from "vitest";
import { latestStopChecks, nodeConnectionView, stopCheckKey } from "./stop-evidence";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("nodeConnectionView", () => {
  it("reports a removed node as null, and offline since its disconnect", () => {
    expect(nodeConnectionView(null, NOW)).toBeNull();
    expect(
      nodeConnectionView(
        {
          connection: "OFFLINE",
          lastConnectedAt: at("2026-10-07T09:00:00.000Z"),
          lastDisconnectedAt: at("2026-10-07T11:00:00.000Z"),
          lastHeartbeatAt: at("2026-10-07T10:59:00.000Z"),
        },
        NOW,
      ),
    ).toEqual({ state: "OFFLINE", since: "2026-10-07T11:00:00.000Z" });
  });

  it("reports online since the connect, but offline once the heartbeat is stale", () => {
    const node = {
      connection: "ONLINE" as const,
      lastConnectedAt: at("2026-10-07T09:00:00.000Z"),
      lastDisconnectedAt: null,
      lastHeartbeatAt: at("2026-10-07T11:59:00.000Z"),
    };
    expect(nodeConnectionView(node, NOW)).toEqual({
      state: "ONLINE",
      since: "2026-10-07T09:00:00.000Z",
    });
    expect(
      nodeConnectionView({ ...node, lastHeartbeatAt: at("2026-10-07T11:50:00.000Z") }, NOW),
    ).toEqual({ state: "OFFLINE", since: "2026-10-07T11:50:00.000Z" });
  });
});

describe("latestStopChecks", () => {
  it("reads each stopping rank's last finished check of this stop only", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { instanceId: string; rank: number } }) =>
      where.rank === 0
        ? {
            instanceId: where.instanceId,
            rank: 0,
            state: "FAILED",
            errorCode: null,
            updatedAt: at("2026-10-07T11:55:00.000Z"),
          }
        : null,
    );
    const stopRequested = at("2026-10-07T11:00:00.000Z");
    const checks = await latestStopChecks({ instanceStep: { findFirst } } as never, [
      {
        id: "stuck",
        phase: "STOPPING",
        phaseChangedAt: stopRequested,
        Ranks: [{ rank: 0 }, { rank: 1 }],
      },
      { id: "ready", phase: "READY", phaseChangedAt: stopRequested, Ranks: [{ rank: 0 }] },
    ]);
    // Only the stopping instance is read, one lookup per rank, from when it began stopping.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        instanceId: "stuck",
        rank: 0,
        phase: "STATUS",
        state: { in: ["SUCCEEDED", "FAILED"] },
        createdAt: { gte: stopRequested },
      },
      orderBy: { sequence: "desc" },
    });
    expect([...checks.entries()]).toEqual([
      [
        stopCheckKey("stuck", 0),
        { at: "2026-10-07T11:55:00.000Z", proven: false, errorCode: null },
      ],
    ]);
  });
});
