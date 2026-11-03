import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const {
  createRoutingEvaluationState,
  evaluationClosed,
  MetricRoutingEvaluator,
  ROUTING_EVALUATION_MIN_INTERVAL_MS,
} = await import("./metric-routing-evaluator.js");

type EvaluatorDb = ConstructorParameters<typeof MetricRoutingEvaluator>[0];

function harness() {
  let nowMs = 1_000_000;
  const findMany = vi.fn(async () => []);
  const db = { executionTarget: { findMany } } as unknown as EvaluatorDb;
  const evaluator = new MetricRoutingEvaluator(db, () => new Date(nowMs));
  const state = createRoutingEvaluationState("owner-1", "node-1");
  const inputs = () => ({ nodeMetrics: null, runtimeLoad: [] });
  return {
    evaluator,
    state,
    inputs,
    findMany,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("MetricRoutingEvaluator scheduling", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces frames to one evaluation per node per interval", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.evaluator.schedule(h.state, h.inputs);
    h.evaluator.schedule(h.state, h.inputs);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.findMany).toHaveBeenCalledTimes(1);

    h.evaluator.schedule(h.state, h.inputs);
    h.evaluator.schedule(h.state, h.inputs);
    await vi.advanceTimersByTimeAsync(ROUTING_EVALUATION_MIN_INTERVAL_MS / 2);
    expect(h.findMany).toHaveBeenCalledTimes(1);
    h.advance(ROUTING_EVALUATION_MIN_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ROUTING_EVALUATION_MIN_INTERVAL_MS);
    expect(h.findMany).toHaveBeenCalledTimes(2);
  });

  it("never evaluates after cancel, including a trailing run already scheduled", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.evaluator.schedule(h.state, h.inputs);
    h.evaluator.cancel(h.state);
    expect(evaluationClosed(h.state)).toBe(true);
    h.evaluator.schedule(h.state, h.inputs);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("a session cancelled before any frame is closed", () => {
    const h = harness();
    expect(evaluationClosed(h.state)).toBe(false);
    h.evaluator.cancel(h.state);
    expect(evaluationClosed(h.state)).toBe(true);
  });
});
