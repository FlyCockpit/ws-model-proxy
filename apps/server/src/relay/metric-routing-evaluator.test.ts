import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import {
  createRoutingEvaluationState,
  MetricRoutingEvaluator,
  ROUTING_EVALUATION_MIN_INTERVAL_MS,
  VERDICT_REFRESH_MS,
} from "./metric-routing-evaluator.js";

const T0 = new Date("2026-09-28T12:00:00.000Z");

function member(
  id: string,
  rules: unknown,
  endpointSlug = "gpu",
): {
  id: string;
  poolId: string;
  ModelPool: { routingRules: unknown };
  DiscoveredModel: null;
  ExecutionTarget: { DiscoveredModel: { slug: string | null; Endpoint: { slug: string } } };
} {
  return {
    id,
    poolId: `pool-of-${id}`,
    ModelPool: { routingRules: rules },
    DiscoveredModel: null,
    ExecutionTarget: { DiscoveredModel: { slug: null, Endpoint: { slug: endpointSlug } } },
  };
}

const hotRule = [{ metric: "node.gpu.temperature_c", op: ">", threshold: 80, effect: "full" }];
const busyRule = [{ metric: "endpoint.waiting", op: ">=", threshold: 2, effect: "avoid" }];

type Row = {
  poolMemberId: string;
  verdict: string;
  ruleStates: string[];
  evaluatedAt: Date;
  expiresAt: Date;
  poolId: string;
};

/**
 * An in-memory stand-in for the verdict table with the two operations the
 * evaluator uses: a conditional `updateMany` (by `evaluatedAt`) and a
 * `create` that fails like a unique violation (P2002) when the row exists.
 */
function harness(members: ReturnType<typeof member>[]) {
  let now = T0;
  const rows = new Map<string, Row>();
  const pools = new Map<string, unknown>(
    members.map((entry) => [entry.poolId, entry.ModelPool.routingRules]),
  );
  const db = {
    poolMember: { findMany: vi.fn(async () => members) },
    modelPool: {
      findMany: vi.fn(async () =>
        [...pools.entries()].map(([id, routingRules]) => ({ id, routingRules })),
      ),
    },
    poolMemberRoutingVerdict: {
      updateMany: vi.fn(
        async (args: {
          where: { poolMemberId: string; evaluatedAt: { lte: Date } };
          data: Omit<Row, "poolMemberId">;
        }) => {
          const row = rows.get(args.where.poolMemberId);
          if (!row || row.evaluatedAt > args.where.evaluatedAt.lte) return { count: 0 };
          rows.set(row.poolMemberId, { ...row, ...args.data });
          return { count: 1 };
        },
      ),
      create: vi.fn(async (args: { data: Row }) => {
        if (rows.has(args.data.poolMemberId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        rows.set(args.data.poolMemberId, { ...args.data });
        return {};
      }),
      deleteMany: vi.fn(
        async (args: { where: { poolMemberId: { in: string[] }; evaluatedAt: Date } }) => {
          let count = 0;
          for (const id of args.where.poolMemberId.in) {
            const row = rows.get(id);
            if (row && row.evaluatedAt.getTime() === args.where.evaluatedAt.getTime()) {
              rows.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
  };
  const evaluator = new MetricRoutingEvaluator(db as never, () => now);
  return {
    db,
    rows,
    evaluator,
    /** Replace a pool's rules, as `setPoolRoutingRules` does (rules, then clear its verdicts). */
    editRules: (poolId: string, rules: unknown) => {
      pools.set(poolId, rules);
      for (const [id, row] of rows) if (row.poolId === poolId) rows.delete(id);
    },
    setRulesWithoutClearing: (poolId: string, rules: unknown) => {
      pools.set(poolId, rules);
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

function metrics(temperature: number, receivedAt: Date) {
  return {
    nodeMetrics: {
      sample: { ts: receivedAt.toISOString(), gpus: [{ index: 0, temperatureC: temperature }] },
      receivedAt,
    },
    endpointLoad: [],
  };
}

describe("MetricRoutingEvaluator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a FULL verdict for a member on this device whose rule triggers", async () => {
    const h = harness([member("m1", hotRule), member("m2", [])]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tier: "PRIMARY", ModelPool: { userId: "user-1" } }),
      }),
    );
    // Members of pools without rules get no verdict row.
    expect([...h.rows.keys()]).toEqual(["m1"]);
    expect(h.db.poolMemberRoutingVerdict.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        poolMemberId: "m1",
        userId: "user-1",
        poolId: "pool-of-m1",
        cliDeviceId: "device-1",
        verdict: "FULL",
        ruleStates: ["triggered"],
        evaluatedAt: T0,
        // Built-ins are stale 90 s after receipt.
        expiresAt: new Date(T0.getTime() + 90_000),
      }),
    });
  });

  it("uses the member's own endpoint load for endpoint.* rules", async () => {
    const h = harness([member("m1", busyRule, "a"), member("m2", busyRule, "b")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [
        { endpointSlug: "a", modelSlug: null, running: 1, waiting: 3, receivedAt: T0 },
        { endpointSlug: "b", modelSlug: null, running: 1, waiting: 0, receivedAt: T0 },
      ],
    });
    expect([...h.rows.values()].map((row) => [row.poolMemberId, row.verdict])).toEqual([
      ["m1", "AVOID"],
      ["m2", "NONE"],
    ]);
  });

  it("marks a rule stale (verdict none) when its metric is missing", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [] });
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", ruleStates: ["stale"] });
  });

  it("rewrites an unchanged verdict only after the refresh interval, a changed one at once", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    const writes = () =>
      h.db.poolMemberRoutingVerdict.create.mock.calls.length +
      h.db.poolMemberRoutingVerdict.updateMany.mock.calls.length;
    // First evaluation: a miss on updateMany, then the create.
    expect(h.db.poolMemberRoutingVerdict.create).toHaveBeenCalledTimes(1);
    const afterFirst = writes();
    h.advance(VERDICT_REFRESH_MS);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(writes()).toBeGreaterThan(afterFirst);
    const afterRefresh = writes();
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(40, h.now()));
    expect(writes()).toBeGreaterThan(afterRefresh);
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("never overwrites a newer evaluation's verdict with an older one (stalled run, reconnect)", async () => {
    // Session A starts (t0) and stalls in its member read; session B starts
    // later (t0+50ms), writes NONE and finishes; A then resumes and tries to
    // publish its stale FULL. It must lose.
    const h = harness([member("m1", hotRule)]);
    const a = createRoutingEvaluationState("user-1", "device-1");
    const b = createRoutingEvaluationState("user-1", "device-1");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realFind = h.db.poolMember.findMany.getMockImplementation();
    h.db.poolMember.findMany.mockImplementationOnce(async () => {
      await gate;
      return realFind ? realFind() : [];
    });
    const first = h.evaluator.evaluate(a, metrics(90, T0));
    h.advance(50);
    await h.evaluator.evaluate(b, metrics(40, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
    release();
    await first;
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("an older evaluation that wins the create race is overwritten by the newer one", async () => {
    // Row absent: newer B's updateMany misses, older A creates first, then
    // B's create hits the unique violation. B must still win (its
    // evaluatedAt is newer), not read the violation as "a newer row exists".
    const h = harness([member("m1", hotRule)]);
    const older = createRoutingEvaluationState("user-1", "device-1");
    const newer = createRoutingEvaluationState("user-1", "device-1");
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    let ran = false;
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      // B's create is about to run: the older evaluation slips in first.
      if (!ran) {
        ran = true;
        h.advance(-50);
        await h.evaluator.evaluate(older, metrics(90, h.now()));
        h.advance(50);
      }
      return create ? create(args) : {};
    });
    await h.evaluator.evaluate(newer, metrics(40, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("publishes nothing once its session was cancelled mid-evaluation", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realFind = h.db.poolMember.findMany.getMockImplementation();
    h.db.poolMember.findMany.mockImplementationOnce(async () => {
      await gate;
      return realFind ? realFind() : [];
    });
    const pending = h.evaluator.evaluate(state, metrics(90, T0));
    h.evaluator.cancel(state);
    release();
    await pending;
    expect(h.rows.size).toBe(0);
  });

  it("retracts a verdict written under rules that were edited during the evaluation", async () => {
    // The evaluation read the old rules; the edit (rules committed, then its
    // rows cleared) happens before the evaluation's write commits, so the
    // clearing missed it. The evaluation's re-check must remove it, and only
    // its own row.
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const publish = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (publish ? publish(args) : Promise.resolve({}));
      h.setRulesWithoutClearing("pool-of-m1", []);
      return result;
    });
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.size).toBe(0);
    // With no rules left nothing writes it back, and the next run is quiet.
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.rows.size).toBe(0);
  });

  it("stops publishing the remaining members once its session is cancelled between writes", async () => {
    const h = harness([member("m1", hotRule), member("m2", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (create ? create(args) : Promise.resolve({}));
      h.evaluator.cancel(state);
      return result;
    });
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect([...h.rows.keys()]).toEqual(["m1"]);
  });

  it("keeps a verdict whose rules did not change while it was written", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL" });
    expect(h.db.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
  });

  it("re-writes at once after a rule edit even when the verdict is unchanged", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    const other = [{ metric: "node.gpu.temperature_c", op: ">", threshold: 70, effect: "full" }];
    h.editRules("pool-of-m1", other);
    h.db.poolMember.findMany.mockResolvedValue([member("m1", other)]);
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL" });
  });

  it("coalesces frames to one evaluation per device per second and stops when cancelled", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const inputs = () => metrics(90, h.now());
    h.evaluator.schedule(state, inputs);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.db.poolMember.findMany).toHaveBeenCalledTimes(1);
    h.evaluator.schedule(state, inputs);
    h.evaluator.schedule(state, inputs);
    h.evaluator.schedule(state, inputs);
    await vi.advanceTimersByTimeAsync(ROUTING_EVALUATION_MIN_INTERVAL_MS - 10);
    expect(h.db.poolMember.findMany).toHaveBeenCalledTimes(1);
    h.advance(ROUTING_EVALUATION_MIN_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.db.poolMember.findMany).toHaveBeenCalledTimes(2);
    h.evaluator.schedule(state, inputs);
    h.evaluator.cancel(state);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.db.poolMember.findMany).toHaveBeenCalledTimes(2);
  });

  it("logs only the error class when an evaluation fails", async () => {
    const h = harness([]);
    h.db.poolMember.findMany.mockRejectedValueOnce(new TypeError("secret detail"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.run(state, () => metrics(90, T0));
    expect(error).toHaveBeenCalledWith("[relay] metric routing evaluation failed", "TypeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
    error.mockRestore();
  });
});
