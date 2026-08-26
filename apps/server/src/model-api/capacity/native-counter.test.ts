import { describe, expect, it, vi } from "vitest";
import { NativeContextCounter } from "./native-counter.js";

describe("NativeContextCounter", () => {
  it("calls a supported direct counter exactly once and marks it exact", async () => {
    const request = vi.fn().mockResolvedValue(42);
    await expect(new NativeContextCounter(true, request).count({ input: "x" })).resolves.toEqual({
      tokens: 42,
      method: "NATIVE",
      exact: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the target lacks native count support", async () => {
    const request = vi.fn();
    await expect(new NativeContextCounter(false, request).count({})).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back on native failure but preserves caller cancellation", async () => {
    await expect(
      new NativeContextCounter(true, vi.fn().mockRejectedValue(new Error("upstream"))).count({}),
    ).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new NativeContextCounter(true, vi.fn()).count({}, controller.signal),
    ).rejects.toThrow("cancelled");
  });
});
