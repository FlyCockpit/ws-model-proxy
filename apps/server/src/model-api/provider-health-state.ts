// A half-open claim is a lease, not a permanent latch. Provider attempts are
// heartbeated every ten seconds, so one minute allows ample scheduling jitter
// while guaranteeing recovery after a worker dies between claim and outcome.
export const PROVIDER_HALF_OPEN_LEASE_MS = 60_000;

/** The health columns shared by `provider_account` and `provider_model`. */
export type ProviderHealthWindow = {
  healthNextRetryAt: Date | null;
  healthHalfOpenAt: Date | null;
};

/** The half-open owner columns (the attempt that claimed the trial, and its fencing token). */
export type ProviderHealthOwner = {
  healthHalfOpenAttemptId: string | null;
  healthHalfOpenFencingToken: bigint | null;
};

/** A claimed half-open trial: `live` while its lease (renewed by heartbeats) has not lapsed. */
export type ProviderHealthTrial = { startedAt: Date; live: boolean };

/**
 * The circuit breaker an account's or model's health columns encode at `now` (the `health` enum
 * is the reported status; admission gates on these columns). Half-open has no state value of its
 * own; it is implied by the retry time having passed:
 *
 * - `closed`: no failure recorded (`healthNextRetryAt` null);
 * - `open`: a failure's backoff has not elapsed (`healthNextRetryAt > now`);
 * - `half_open`: the backoff elapsed; `trial` is the claimed trial (`healthHalfOpenAt`), or null
 *   when none was claimed. A trial whose lease lapsed is claimable again, like none.
 */
export type ProviderBreakerState =
  | { kind: "closed" }
  | { kind: "open"; retryAt: Date }
  | { kind: "half_open"; trial: ProviderHealthTrial | null };

/** The one derivation of {@link ProviderBreakerState}; every reader goes through it. */
export function providerBreakerState(
  health: ProviderHealthWindow,
  now: Date,
): ProviderBreakerState {
  const retryAt = health.healthNextRetryAt;
  if (retryAt === null) return { kind: "closed" };
  if (retryAt > now) return { kind: "open", retryAt };
  const startedAt = health.healthHalfOpenAt;
  if (startedAt === null) return { kind: "half_open", trial: null };
  const liveLeaseCutoff = now.getTime() - PROVIDER_HALF_OPEN_LEASE_MS;
  return { kind: "half_open", trial: { startedAt, live: startedAt.getTime() > liveLeaseCutoff } };
}

/** Whether a new attempt may not start: still open, or a half-open trial is live. */
export function providerBreakerRefuses(state: ProviderBreakerState): boolean {
  return state.kind === "open" || (state.kind === "half_open" && state.trial?.live === true);
}

/**
 * Whether an account's or model's health state refuses a new attempt at
 * `now`: a recorded failure (`healthNextRetryAt` set) whose backoff has not
 * elapsed, or whose half-open trial lease is still live. This is the rule
 * claimProviderHealthTrial enforces under its locks; target listing uses the
 * same rule so a member that the trial claim would refuse is classified as
 * cooling down (temporarily unavailable) rather than dispatched.
 */
export function providerHealthCoolingDown(health: ProviderHealthWindow, now: Date): boolean {
  return providerBreakerRefuses(providerBreakerState(health, now));
}

/** The half-open trial is claimed by exactly this attempt (id and fencing token). */
export function providerTrialOwnedBy(
  health: ProviderHealthOwner,
  attemptId: string | undefined,
  fencingToken: bigint | undefined,
): boolean {
  return (
    health.healthHalfOpenAttemptId !== null &&
    health.healthHalfOpenAttemptId === attemptId &&
    health.healthHalfOpenFencingToken === fencingToken
  );
}

/** No attempt owns a half-open trial. */
export function providerTrialUnclaimed(health: ProviderHealthOwner): boolean {
  return health.healthHalfOpenAttemptId === null;
}
