import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import {
  providerAttemptExpiryEnabled,
  startProviderAttemptExpiry,
} from "./provider-attempt-lifecycle.js";

describe("provider-attempt expiry lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("runs immediately and periodically without overlapping sweeps", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const expire = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const stop = startProviderAttemptExpiry(expire, 100);

    await vi.advanceTimersByTimeAsync(0);
    expect(expire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(expire).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(expire).toHaveBeenCalledTimes(2);
    stop();
    release();
  });

  it("stops future sweeps", async () => {
    vi.useFakeTimers();
    const expire = vi.fn().mockResolvedValue(undefined);
    const stop = startProviderAttemptExpiry(expire, 100);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
it("follows public egress independently of the global-capacity flag", () => {
  expect(providerAttemptExpiryEnabled(true)).toBe(true);
  expect(providerAttemptExpiryEnabled(false)).toBe(false);
});
