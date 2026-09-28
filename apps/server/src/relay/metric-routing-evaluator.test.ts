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

function harness(members: ReturnType<typeof member>[]) {
  let now = T0;
  const db = {
    poolMember: { findMany: vi.fn(async () => members) },
    poolMemberRoutingVerdict: { upsert: vi.fn(async () => ({})) },
  };
  const evaluator = new MetricRoutingEvaluator(db as never, () => now);
  return {
    db,
    evaluator,
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
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledTimes(1);
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledWith({
      where: { poolMemberId: "m1" },
      create: expect.objectContaining({
        poolMemberId: "m1",
        userId: "user-1",
        poolId: "pool-of-m1",
        cliDeviceId: "device-1",
        verdict: "FULL",
        ruleStates: ["triggered"],
        // Built-ins are stale 90 s after receipt.
        expiresAt: new Date(T0.getTime() + 90_000),
      }),
      update: expect.objectContaining({ verdict: "FULL" }),
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
    const verdicts = h.db.poolMemberRoutingVerdict.upsert.mock.calls.map(
      (call) =>
        (call as unknown as [{ create: { poolMemberId: string; verdict: string } }])[0].create,
    );
    expect(verdicts.map((row) => [row.poolMemberId, row.verdict])).toEqual([
      ["m1", "AVOID"],
      ["m2", "NONE"],
    ]);
  });

  it("marks a rule stale (verdict none) when its metric is missing", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [] });
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ verdict: "NONE", ruleStates: ["stale"] }),
      }),
    );
  });

  it("rewrites an unchanged verdict only after the refresh interval, a changed one at once", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledTimes(1);
    h.advance(VERDICT_REFRESH_MS);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledTimes(2);
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(40, h.now()));
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenCalledTimes(3);
    expect(h.db.poolMemberRoutingVerdict.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ verdict: "NONE" }) }),
    );
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
