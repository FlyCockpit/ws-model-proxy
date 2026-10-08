import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/api/lib/needs-you-mail", () => ({ sweepNeedsYouMail: vi.fn() }));
const fence = vi.hoisted(() => ({ armed: false }));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({
  isDbShutdownFenceArmed: () => fence.armed,
}));

import { startNeedsYouMail } from "./needs-you-mail.js";

afterEach(() => {
  vi.useRealTimers();
  fence.armed = false;
});

describe("startNeedsYouMail", () => {
  it("sweeps on the interval, never overlapping, and logs a failure by class only", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const sweep = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(1))))
      .mockRejectedValueOnce(new Error("select * from secret"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startNeedsYouMail({ intervalMs: 100, sweep });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("[needs-you] e-mail sweep failed:", "Error");
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sweep).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("does not start a run once the shutdown fence is armed", async () => {
    vi.useFakeTimers();
    fence.armed = true;
    const sweep = vi.fn(async () => 0);
    const stop = startNeedsYouMail({ intervalMs: 100, sweep });
    await vi.advanceTimersByTimeAsync(300);
    expect(sweep).not.toHaveBeenCalled();
    stop();
  });
});
