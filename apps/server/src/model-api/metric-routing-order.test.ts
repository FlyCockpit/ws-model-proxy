import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { applyMetricRoutingVerdicts } from "./metric-routing-order.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const candidates = ["a", "b", "c", "d"].map((poolMemberId) => ({ poolMemberId, weight: 1 }));

function dbWith(rows: Array<{ poolMemberId: string; verdict: "NONE" | "AVOID" | "FULL" }>) {
  return {
    poolMemberRoutingVerdict: { findMany: vi.fn(async () => rows) },
  };
}

describe("applyMetricRoutingVerdicts (candidate build)", () => {
  it("reads only fresh FULL/AVOID verdicts of these candidates", async () => {
    const db = dbWith([]);
    await applyMetricRoutingVerdicts(candidates, { db: db as never, now: NOW });
    expect(db.poolMemberRoutingVerdict.findMany).toHaveBeenCalledWith({
      where: {
        poolMemberId: { in: ["a", "b", "c", "d"] },
        verdict: { in: ["FULL", "AVOID"] },
        expiresAt: { gt: NOW },
      },
      select: { poolMemberId: true, verdict: true },
    });
  });

  it("drops metric-FULL members", async () => {
    const result = await applyMetricRoutingVerdicts(candidates, {
      db: dbWith([{ poolMemberId: "b", verdict: "FULL" }]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual(["a", "c", "d"]);
    expect(result).toMatchObject({ droppedFull: ["b"], allFull: false });
  });

  it("moves avoid members last, keeping relative order, without dropping them", async () => {
    const result = await applyMetricRoutingVerdicts(candidates, {
      db: dbWith([
        { poolMemberId: "a", verdict: "AVOID" },
        { poolMemberId: "c", verdict: "AVOID" },
      ]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("keeps every member when all are metric-FULL (admission then decides)", async () => {
    const result = await applyMetricRoutingVerdicts(candidates.slice(0, 2), {
      db: dbWith([
        { poolMemberId: "a", verdict: "FULL" },
        { poolMemberId: "b", verdict: "FULL" },
      ]) as never,
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual(["a", "b"]);
    expect(result).toMatchObject({ droppedFull: [], allFull: true });
  });

  it("leaves the candidates unchanged when the verdict read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      poolMemberRoutingVerdict: {
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
