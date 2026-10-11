import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { applyMetricRoutingVerdicts } from "./metric-routing-order.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const candidates = ["a", "b", "c", "d"].map((poolMemberId) => ({
  poolMemberId,
  executionTargetId: `t-${poolMemberId}`,
  weight: 1,
}));

type Row = { poolMemberId: string; executionTargetId: string; verdict: "NONE" | "AVOID" | "FULL" };

function dbWith(rows: Row[]) {
  return { routingVerdict: { findMany: vi.fn(async () => rows) } };
}

function row(member: string, verdict: Row["verdict"], target = `t-${member}`): Row {
  return { poolMemberId: member, executionTargetId: target, verdict };
}

describe("applyMetricRoutingVerdicts (candidate build)", () => {
  it("reads only fresh FULL/AVOID verdicts of these candidates' members", async () => {
    const db = dbWith([]);
    await applyMetricRoutingVerdicts(candidates, { db: db as never, now: NOW });
    expect(db.routingVerdict.findMany).toHaveBeenCalledWith({
      where: {
        poolMemberId: { in: ["a", "b", "c", "d"] },
        verdict: { in: ["FULL", "AVOID"] },
        expiresAt: { gt: NOW },
      },
      select: { poolMemberId: true, executionTargetId: true, verdict: true },
    });
  });

  it("drops metric-FULL routes", async () => {
    const result = await applyMetricRoutingVerdicts(candidates, {
      db: dbWith([row("b", "FULL")]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual(["a", "c", "d"]);
    expect(result).toMatchObject({ droppedFull: ["b:t-b"], allFull: false });
  });

  it("judges each (member, target) route on its own", async () => {
    const result = await applyMetricRoutingVerdicts(candidates, {
      db: dbWith([row("b", "FULL", "t-other")]) as never,
      now: NOW,
    });
    expect(result.candidates).toHaveLength(4);
  });

  it("moves avoid routes last, keeping relative order, without dropping them", async () => {
    const result = await applyMetricRoutingVerdicts(candidates, {
      db: dbWith([row("a", "AVOID"), row("c", "AVOID")]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("keeps every route when all are metric-FULL (admission then decides)", async () => {
    const result = await applyMetricRoutingVerdicts(candidates.slice(0, 2), {
      db: dbWith([row("a", "FULL"), row("b", "FULL")]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual(["a", "b"]);
    expect(result).toMatchObject({ droppedFull: [], allFull: true });
  });

  it("leaves the candidates unchanged when the verdict read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      routingVerdict: {
        findMany: vi.fn(async () => {
          throw new Error("db down: secret");
        }),
      },
    };
    const result = await applyMetricRoutingVerdicts(candidates, { db: db as never, now: NOW });
    expect(result.candidates).toEqual(candidates);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });
});
