import { describe, expect, it, vi } from "vitest";
import {
  liveNodeWhere,
  NODE_HEARTBEAT_STALE_MS,
  type NodeLivenessRow,
  nodeIsLive,
  nodeLiveness,
  nodeUnreachableSince,
} from "./node-liveness";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const NOW = new Date("2026-11-03T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);
const DISCONNECTED = at(60 * 60_000);

/** `liveNodeWhere` evaluated on a row (its shape: connection, then an OR on the heartbeat). */
function matchesLiveWhere(row: NodeLivenessRow): boolean {
  const where = liveNodeWhere(NOW);
  if (row.connection !== where.connection) return false;
  const branches = where.OR ?? [];
  return branches.some((branch) => {
    const condition = branch.lastHeartbeatAt;
    if (condition === null) return row.lastHeartbeatAt === null;
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const gte = "gte" in condition ? condition.gte : undefined;
      return (
        row.lastHeartbeatAt !== null &&
        gte instanceof Date &&
        row.lastHeartbeatAt.getTime() >= gte.getTime()
      );
    }
    throw new Error("unexpected heartbeat condition");
  });
}

describe("nodeLiveness", () => {
  it("online: connected with a fresh heartbeat, or none recorded yet", () => {
    expect(nodeLiveness({ connection: "ONLINE", lastHeartbeatAt: at(10_000) }, NOW)).toEqual({
      state: "online",
    });
    expect(nodeLiveness({ connection: "ONLINE", lastHeartbeatAt: null }, NOW)).toEqual({
      state: "online",
    });
    // Exactly at the bound is still fresh.
    expect(
      nodeLiveness({ connection: "ONLINE", lastHeartbeatAt: at(NODE_HEARTBEAT_STALE_MS) }, NOW)
        .state,
    ).toBe("online");
  });

  it("stale: ONLINE whose heartbeat went silent, since that heartbeat", () => {
    const last = at(NODE_HEARTBEAT_STALE_MS + 1);
    expect(nodeLiveness({ connection: "ONLINE", lastHeartbeatAt: last }, NOW)).toEqual({
      state: "stale",
      since: last,
    });
  });

  it("offline: since its disconnect (null when none was recorded)", () => {
    expect(
      nodeLiveness(
        { connection: "OFFLINE", lastHeartbeatAt: at(1_000), lastDisconnectedAt: DISCONNECTED },
        NOW,
      ),
    ).toEqual({ state: "offline", since: DISCONNECTED });
    expect(nodeLiveness({ connection: "OFFLINE", lastHeartbeatAt: null }, NOW)).toEqual({
      state: "offline",
      since: null,
    });
  });
});

describe("the readers' forms agree", () => {
  const rows: NodeLivenessRow[] = [];
  for (const connection of ["ONLINE", "OFFLINE"] as const)
    for (const lastHeartbeatAt of [
      null,
      at(0),
      at(NODE_HEARTBEAT_STALE_MS - 1),
      at(NODE_HEARTBEAT_STALE_MS),
      at(NODE_HEARTBEAT_STALE_MS + 1),
      at(24 * 60 * 60_000),
    ])
      for (const lastDisconnectedAt of [null, DISCONNECTED])
        rows.push({ connection, lastHeartbeatAt, lastDisconnectedAt });

  it("nodeIsLive, liveNodeWhere and nodeUnreachableSince name the same live rows", () => {
    for (const row of rows) {
      const live = nodeLiveness(row, NOW).state === "online";
      expect(nodeIsLive(row, NOW), JSON.stringify(row)).toBe(live);
      expect(matchesLiveWhere(row), JSON.stringify(row)).toBe(live);
      expect(nodeUnreachableSince(row, NOW) === null, JSON.stringify(row)).toBe(live);
    }
  });

  it("a missing row is not live", () => {
    expect(nodeIsLive(null, NOW)).toBe(false);
    expect(nodeIsLive(undefined, NOW)).toBe(false);
  });

  it("unreachable since: the disconnect (epoch when unknown) or the stale heartbeat", () => {
    expect(
      nodeUnreachableSince(
        { connection: "OFFLINE", lastHeartbeatAt: null, lastDisconnectedAt: DISCONNECTED },
        NOW,
      ),
    ).toBe(DISCONNECTED);
    expect(nodeUnreachableSince({ connection: "OFFLINE", lastHeartbeatAt: null }, NOW)).toEqual(
      new Date(0),
    );
    const last = at(NODE_HEARTBEAT_STALE_MS * 2);
    expect(nodeUnreachableSince({ connection: "ONLINE", lastHeartbeatAt: last }, NOW)).toBe(last);
  });
});
