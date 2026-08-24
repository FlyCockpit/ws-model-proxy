import { afterEach, describe, expect, it, vi } from "vitest";
import { remainingRelayBudgetMs } from "./limits.js";

describe("relay wall-clock budget", () => {
  afterEach(() => vi.useRealTimers());

  it("gives later pool attempts only the unspent operation budget", () => {
    const deadline = 20_000;
    expect(remainingRelayBudgetMs(deadline, 5_000)).toBe(15_000);
    expect(remainingRelayBudgetMs(deadline, 19_999)).toBe(1);
  });

  it("clamps an exhausted budget to zero", () => {
    expect(remainingRelayBudgetMs(20_000, 20_000)).toBe(0);
    expect(remainingRelayBudgetMs(20_000, 25_000)).toBe(0);
  });

  it("exhausts against elapsed wall-clock time under fake timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    const deadline = Date.now() + 15 * 60 * 1000;

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 59_999);
    expect(remainingRelayBudgetMs(deadline)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remainingRelayBudgetMs(deadline)).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remainingRelayBudgetMs(deadline)).toBe(0);
  });
});
