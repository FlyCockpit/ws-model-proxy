import { describe, expect, it } from "vitest";
import {
  PROVIDER_HALF_OPEN_LEASE_MS,
  providerBreakerState,
  providerHealthCoolingDown,
  providerTrialOwnedBy,
  providerTrialUnclaimed,
} from "./provider-health-state.js";

const now = new Date("2026-11-03T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe("providerBreakerState", () => {
  it("derives closed, open and half-open from the retry time and the trial lease", () => {
    expect(providerBreakerState({ healthNextRetryAt: null, healthHalfOpenAt: null }, now)).toEqual({
      kind: "closed",
    });
    expect(providerBreakerState({ healthNextRetryAt: at(1), healthHalfOpenAt: null }, now)).toEqual(
      { kind: "open", retryAt: at(1) },
    );
    // Exactly at the retry time the backoff has elapsed.
    expect(providerBreakerState({ healthNextRetryAt: now, healthHalfOpenAt: null }, now)).toEqual({
      kind: "half_open",
      trial: null,
    });
    expect(
      providerBreakerState({ healthNextRetryAt: at(-5), healthHalfOpenAt: at(-1_000) }, now),
    ).toEqual({ kind: "half_open", trial: { startedAt: at(-1_000), live: true } });
    // A lease exactly at the cutoff has lapsed.
    expect(
      providerBreakerState(
        { healthNextRetryAt: at(-5), healthHalfOpenAt: at(-PROVIDER_HALF_OPEN_LEASE_MS) },
        now,
      ),
    ).toEqual({
      kind: "half_open",
      trial: { startedAt: at(-PROVIDER_HALF_OPEN_LEASE_MS), live: false },
    });
  });

  it("refuses new attempts while open or while a half-open trial is live", () => {
    const cases: Array<[Date | null, Date | null, boolean]> = [
      [null, null, false],
      [null, at(-1), false],
      [at(1), null, true],
      [now, null, false],
      [at(-5), at(-1), true],
      [at(-5), at(-PROVIDER_HALF_OPEN_LEASE_MS), false],
    ];
    for (const [healthNextRetryAt, healthHalfOpenAt, refused] of cases)
      expect(providerHealthCoolingDown({ healthNextRetryAt, healthHalfOpenAt }, now)).toBe(refused);
  });

  it("identifies the trial owner by attempt id and fencing token", () => {
    const owner = { healthHalfOpenAttemptId: "a1", healthHalfOpenFencingToken: 7n };
    expect(providerTrialOwnedBy(owner, "a1", 7n)).toBe(true);
    expect(providerTrialOwnedBy(owner, "a1", 8n)).toBe(false);
    expect(providerTrialOwnedBy(owner, undefined, undefined)).toBe(false);
    const none = { healthHalfOpenAttemptId: null, healthHalfOpenFencingToken: null };
    expect(providerTrialOwnedBy(none, undefined, undefined)).toBe(false);
    expect(providerTrialUnclaimed(none)).toBe(true);
    expect(providerTrialUnclaimed(owner)).toBe(false);
  });
});
