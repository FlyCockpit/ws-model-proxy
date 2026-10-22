import { describe, expect, it } from "vitest";

import { TerminalFrameBudget } from "./terminal-frame-budget";

describe("TerminalFrameBudget", () => {
  it("lets frames through until the window is full, then waits for the oldest to leave it", () => {
    const budget = new TerminalFrameBudget(3, 1_000);
    expect(budget.waitFor(2, 0)).toBe(0);
    budget.record(0);
    budget.record(100);
    expect(budget.waitFor(1, 200)).toBe(0);
    budget.record(200);
    // Full: the next frame fits once the frame sent at 0 leaves the window.
    expect(budget.waitFor(1, 300)).toBe(700);
    // Two frames need the two oldest gone.
    expect(budget.waitFor(2, 300)).toBe(800);
    expect(budget.waitFor(1, 1_000)).toBe(0);
  });

  it("asks a step of more frames than the whole budget to wait for an empty window only", () => {
    const budget = new TerminalFrameBudget(2, 1_000);
    budget.record(0);
    expect(budget.waitFor(5, 10)).toBe(990);
    expect(budget.waitFor(5, 1_000)).toBe(0);
  });
});
