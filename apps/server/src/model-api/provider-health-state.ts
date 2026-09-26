// A half-open claim is a lease, not a permanent latch. Provider attempts are
// heartbeated every ten seconds, so one minute allows ample scheduling jitter
// while guaranteeing recovery after a worker dies between claim and outcome.
export const PROVIDER_HALF_OPEN_LEASE_MS = 60_000;

/** The health columns shared by `provider_account` and `provider_model`. */
export type ProviderHealthWindow = {
  healthNextRetryAt: Date | null;
  healthHalfOpenAt: Date | null;
};

/**
 * Whether an account's or model's health state refuses a new attempt at
 * `now`: a recorded failure (`healthNextRetryAt` set) whose backoff has not
 * elapsed, or whose half-open trial lease is still live. This is the rule
 * claimProviderHealthTrial enforces under its locks; target listing uses the
 * same rule so a member that the trial claim would refuse is classified as
 * cooling down (temporarily unavailable) rather than dispatched.
 */
export function providerHealthCoolingDown(health: ProviderHealthWindow, now: Date): boolean {
  if (health.healthNextRetryAt === null) return false;
  if (health.healthNextRetryAt > now) return true;
  const liveLeaseCutoff = new Date(now.getTime() - PROVIDER_HALF_OPEN_LEASE_MS);
  return health.healthHalfOpenAt !== null && health.healthHalfOpenAt > liveLeaseCutoff;
}
