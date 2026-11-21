import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => ({
  Prisma: await import("../../../db/prisma/generated/internal/prismaNamespace"),
}));

import { Prisma } from "@ws-model-proxy/db";
import { hiddenInstancesWhere, visibleInstancesWhere } from "./agent-hidden-nodes";
import {
  andServedVisibly,
  hiddenServing,
  NOTHING_HIDDEN,
  ROLLUP_SERVED,
  servedSinceWhere,
  servedVisiblyRequestWhere,
} from "./agent-hidden-serving";

describe("hidden serving (traffic, load and request rows)", () => {
  it("resolves hidden instances once through the shared predicate, and not at all without hidden nodes", async () => {
    const findMany = vi.fn(async () => [{ id: "inst-mixed" }]);
    const db = { runtimeInstance: { findMany } } as unknown as Prisma.TransactionClient;
    const since = new Date("2026-11-12T00:00:00.000Z");
    expect(await hiddenServing(db, [], since)).toBe(NOTHING_HIDDEN);
    expect(findMany).not.toHaveBeenCalled();
    expect(await hiddenServing(db, ["hidden"], since)).toEqual({
      nodeIds: ["hidden"],
      instanceIds: ["inst-mixed"],
    });
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { AND: [hiddenInstancesWhere(["hidden"]), servedSinceWhere(since)] },
      select: { id: true },
    });
    // Live instances always; stopped or failed ones only if they changed phase since.
    expect(servedSinceWhere(since)).toEqual({
      OR: [{ phase: { notIn: ["STOPPED", "FAILED"] } }, { phaseChangedAt: { gte: since } }],
    });
    // The visible-instance filter the counts use is exactly its negation.
    expect(visibleInstancesWhere(["hidden"])).toEqual({ NOT: hiddenInstancesWhere(["hidden"]) });
  });

  it("binds ids as parameters and adds nothing when nothing is hidden", () => {
    const columns = ROLLUP_SERVED;
    expect(andServedVisibly(NOTHING_HIDDEN, columns)).toBe(Prisma.empty);
    const both = andServedVisibly(
      { nodeIds: ["n' OR TRUE --"], instanceIds: ["i' OR TRUE --"] },
      columns,
    );
    expect(both.sql).toBe(
      ` AND NOT (COALESCE("nodeId", '') = ANY(?::text[])) AND NOT (COALESCE("instanceId", '') = ANY(?::text[]))`,
    );
    expect(both.values).toEqual([["n' OR TRUE --"], ["i' OR TRUE --"]]);
    // Hidden nodes without a hidden instance only filter the node.
    expect(andServedVisibly({ nodeIds: ["n"], instanceIds: [] }, columns).sql).toBe(
      ` AND NOT (COALESCE("nodeId", '') = ANY(?::text[]))`,
    );
  });

  it("keeps request rows without a node or instance", () => {
    expect(servedVisiblyRequestWhere(NOTHING_HIDDEN)).toEqual([]);
    expect(servedVisiblyRequestWhere({ nodeIds: ["n"], instanceIds: ["i"] })).toEqual([
      { OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: ["n"] } }] },
      { OR: [{ selectedInstanceId: null }, { selectedInstanceId: { notIn: ["i"] } }] },
    ]);
  });
});
