import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptanceRetryOf,
  advanceOperatorStep,
  endAcceptanceRetry,
  newOperatorStep,
  type OperatorStep,
  operatorStepLive,
  startAcceptanceRetry,
} from "./operator-step.js";

function step(): OperatorStep {
  return newOperatorStep({
    stepId: "step-1",
    instanceId: "inst-1",
    rank: 0,
    phase: "start",
    intentHash: "a".repeat(64),
    ownerEpoch: "e1:1",
    terminalId: "term-1",
    userId: "user-1",
    nodeId: "node-1",
  });
}

describe("operator step stages", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks spawning -> awaiting -> running -> cancelling, and nothing else", () => {
    const tracked = step();
    expect(tracked.stage.kind).toBe("spawning");
    expect(advanceOperatorStep(tracked, "running")).toBe(false);
    expect(advanceOperatorStep(tracked, "awaiting")).toBe(true);
    expect(advanceOperatorStep(tracked, "awaiting")).toBe(false);
    expect(advanceOperatorStep(tracked, "running")).toBe(true);
    expect(advanceOperatorStep(tracked, "awaiting")).toBe(false);
    expect(operatorStepLive(tracked)).toBe(true);
    expect(advanceOperatorStep(tracked, "cancelling")).toBe(true);
    expect(operatorStepLive(tracked)).toBe(false);
    expect(advanceOperatorStep(tracked, "cancelling")).toBe(false);
    expect(advanceOperatorStep(tracked, "running")).toBe(false);
  });

  it.each(["spawning", "awaiting"] as const)("a step can be cancelled while %s", (from) => {
    const tracked = step();
    if (from === "awaiting") advanceOperatorStep(tracked, "awaiting");
    expect(advanceOperatorStep(tracked, "cancelling")).toBe(true);
  });

  it("only a running step has an acceptance retry chain, one at a time", () => {
    const tracked = step();
    expect(startAcceptanceRetry(tracked)).toBeNull();
    advanceOperatorStep(tracked, "awaiting");
    expect(startAcceptanceRetry(tracked)).toBeNull();
    advanceOperatorStep(tracked, "running");
    const chain = startAcceptanceRetry(tracked);
    expect(chain).toEqual({ attempt: 0, timer: null });
    expect(acceptanceRetryOf(tracked)).toBe(chain);
    // A repeated failure joins the chain.
    expect(startAcceptanceRetry(tracked)).toBeNull();
    endAcceptanceRetry(tracked);
    expect(acceptanceRetryOf(tracked)).toBeNull();
    expect(startAcceptanceRetry(tracked)).not.toBeNull();
  });

  it("leaving running ends the chain and clears its timer", () => {
    vi.useFakeTimers();
    const tracked = step();
    advanceOperatorStep(tracked, "awaiting");
    advanceOperatorStep(tracked, "running");
    const chain = startAcceptanceRetry(tracked);
    if (!chain) throw new Error("no chain");
    const fired = vi.fn();
    chain.timer = setTimeout(fired, 1_000);
    advanceOperatorStep(tracked, "cancelling");
    expect(acceptanceRetryOf(tracked)).toBeNull();
    expect(chain.timer).toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(fired).not.toHaveBeenCalled();
  });
});
