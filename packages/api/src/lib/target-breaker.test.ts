import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const {
  TARGET_HALF_OPEN_LEASE_MS,
  targetBreakerState,
  targetCoolingDownWhere,
  targetDueWhere,
  targetHalfOpenClaimableWhere,
  targetHealthStatuses,
  targetNoTrialInFlightWhere,
  targetOpenCoolingDownWhere,
  targetRoutingHealth,
  targetTrialHeldBy,
  targetTrialInFlight,
  transitionTargetHealthAfterRetryableFailure,
} = await import("./pool-routing");

type Row = {
  health: (typeof targetHealthStatuses)[number];
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
};
type Where = Record<string, unknown>;

/** Evaluates the Prisma where subset the breaker builders use. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((part) => matches(row, part));
    if (key === "NOT") return !matches(row, condition as Where);
    const value = row[key as keyof Row];
    if (condition === null || typeof condition === "string") return value === condition;
    const filter = condition as { in?: string[]; not?: string; gt?: Date; lte?: Date };
    if (filter.in) return typeof value === "string" && filter.in.includes(value);
    if ("not" in filter) return value !== filter.not;
    if (!(value instanceof Date)) return false;
    if (filter.gt) return value.getTime() > filter.gt.getTime();
    if (filter.lte) return value.getTime() <= filter.lte.getTime();
    throw new Error(`unsupported filter on ${key}`);
  });
}

const now = new Date("2026-11-03T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const times = [
  null,
  at(-TARGET_HALF_OPEN_LEASE_MS - 1),
  at(-TARGET_HALF_OPEN_LEASE_MS),
  at(-1),
  now,
  at(1),
];

const rows: Row[] = [];
for (const health of targetHealthStatuses)
  for (const nextRetryAt of times)
    for (const halfOpenTrialStartedAt of times)
      rows.push({ health, nextRetryAt, halfOpenTrialStartedAt });

describe("targetBreakerState", () => {
  it("derives every breaker state from the health columns", () => {
    expect(
      targetBreakerState(
        { health: "UNKNOWN", nextRetryAt: null, halfOpenTrialStartedAt: null },
        now,
      ),
    ).toEqual({ kind: "closed" });
    expect(
      targetBreakerState(
        { health: "DEGRADED", nextRetryAt: at(1), halfOpenTrialStartedAt: null },
        now,
      ),
    ).toEqual({ kind: "degraded", retryAt: at(1), due: false });
    expect(
      targetBreakerState(
        { health: "UNHEALTHY", nextRetryAt: now, halfOpenTrialStartedAt: null },
        now,
      ),
    ).toEqual({ kind: "open", retryAt: now, due: true });
    // An open circuit with no retry time is never due.
    expect(
      targetBreakerState(
        { health: "UNHEALTHY", nextRetryAt: null, halfOpenTrialStartedAt: null },
        now,
      ),
    ).toEqual({ kind: "open", retryAt: null, due: false });
    expect(
      targetBreakerState(
        { health: "HALF_OPEN", nextRetryAt: null, halfOpenTrialStartedAt: null },
        now,
      ),
    ).toEqual({ kind: "half_open", trial: null });
    expect(
      targetBreakerState(
        { health: "HALF_OPEN", nextRetryAt: null, halfOpenTrialStartedAt: at(-1) },
        now,
      ),
    ).toEqual({ kind: "half_open", trial: { startedAt: at(-1), live: true } });
    expect(
      targetBreakerState(
        {
          health: "HALF_OPEN",
          nextRetryAt: null,
          halfOpenTrialStartedAt: at(-TARGET_HALF_OPEN_LEASE_MS),
        },
        now,
      ),
    ).toEqual({
      kind: "half_open",
      trial: { startedAt: at(-TARGET_HALF_OPEN_LEASE_MS), live: false },
    });
  });

  it("identifies the trial holder", () => {
    const state = targetBreakerState(
      { health: "HALF_OPEN", nextRetryAt: null, halfOpenTrialStartedAt: at(-1) },
      now,
    );
    expect(targetTrialHeldBy(state, at(-1))).toBe(true);
    expect(targetTrialHeldBy(state, at(-2))).toBe(false);
    expect(targetTrialHeldBy({ kind: "closed" }, at(-1))).toBe(false);
  });

  it("a failure re-opens the circuit from half-open or a due open target", () => {
    const base = { lastFailureClass: null, consecutiveRetryableFailures: 0, lastFailureAt: null };
    const fail = (row: Row) =>
      transitionTargetHealthAfterRetryableFailure({
        target: { ...base, ...row },
        failureClass: "TRANSPORT",
        now,
      }).health;
    expect(fail({ health: "HALF_OPEN", nextRetryAt: null, halfOpenTrialStartedAt: null })).toBe(
      "UNHEALTHY",
    );
    expect(fail({ health: "UNHEALTHY", nextRetryAt: now, halfOpenTrialStartedAt: null })).toBe(
      "UNHEALTHY",
    );
    expect(fail({ health: "HEALTHY", nextRetryAt: null, halfOpenTrialStartedAt: null })).toBe(
      "DEGRADED",
    );
    expect(fail({ health: "DEGRADED", nextRetryAt: now, halfOpenTrialStartedAt: null })).toBe(
      "DEGRADED",
    );
  });
});

describe("target breaker SQL forms match the derivation", () => {
  it("no trial in flight", () => {
    for (const row of rows)
      expect(matches(row, targetNoTrialInFlightWhere(now))).toBe(
        !targetTrialInFlight(targetBreakerState(row, now)),
      );
  });

  it("due for a recovery probe", () => {
    for (const row of rows) {
      const state = targetBreakerState(row, now);
      expect(matches(row, targetDueWhere(now))).toBe(
        (state.kind === "degraded" || state.kind === "open") && state.due,
      );
    }
  });

  it("cooling down (open only, and degraded or open)", () => {
    for (const row of rows) {
      const state = targetBreakerState(row, now);
      expect(matches(row, targetOpenCoolingDownWhere(now))).toBe(
        state.kind === "open" && !state.due,
      );
      expect(matches(row, targetCoolingDownWhere(now))).toBe(
        (state.kind === "degraded" || state.kind === "open") && !state.due,
      );
    }
  });

  it("half-open claimable is exactly what routing offers as HALF_OPEN", () => {
    for (const allowDegraded of [false, true])
      for (const row of rows)
        expect(matches(row, targetHalfOpenClaimableWhere(now, allowDegraded))).toBe(
          targetRoutingHealth(row, now, allowDegraded) === "HALF_OPEN",
        );
  });
});
