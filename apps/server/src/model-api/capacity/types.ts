import type { CapacityLeaseLostError } from "./lease-loss.js";

export type AdmissionCandidate = {
  capacityId: string;
  executionTargetId: string;
  poolMemberId?: string;
  candidateOrder: number;
  /** Candidate-local absolute upper bound; sibling candidates may remain eligible longer. */
  deadlineAt?: Date;
  /**
   * Candidate wait budget in milliseconds, measured on the DATABASE clock
   * from the attempt's spill instant: the latest `notBefore` among its
   * candidates (db_now when no candidate is deferred). The effective deadline
   * is min(deadlineAt ?? attempt.deadlineAt, spillAt + waitBudgetMs). 0 means
   * "admit only if free at the spill instant, else expire" (with no deferral:
   * free in the creating transaction). Undefined or null means no budget
   * (only the absolute bound applies).
   */
  waitBudgetMs?: number | null;
  /**
   * Spill-over delay (saturation S-A) in milliseconds, converted by the store
   * to `notBefore = db_now + notBeforeMs` when the attempt is first persisted.
   * The waiter is not granted (and does not take part in reservation-borrowing
   * arbitration) before then. Undefined or 0 = eligible at once (the cache
   * holder's own candidate, and every candidate without an affinity hit).
   * A deferred waiter always gets one admission check after it becomes
   * eligible: if its owner's polls were delayed past its deadline (lock
   * contention), the next poll runs admission for it once before expiring
   * it; other admitters' deadline sweeps leave deferred waiters to that poll.
   */
  notBeforeMs?: number;
};

export type AdmissionAttempt = {
  attemptId: string;
  requestId: string;
  relayRequestId?: string;
  ownerId: string;
  sourceKind: "DIRECT" | "POOL";
  poolId?: string;
  /** Recorded on the request; the scheduler uses each waiter's effective priority. */
  basePriority: number;
  /**
   * The pool grant the requester was resolved under (grantees only). Its
   * `queuePriority` (S-C), when set, replaces the pool/member capacity
   * priority for every candidate of this attempt; null inherits it.
   */
  accessGrantId?: string | null;
  /**
   * Warm sessions (S-C) this request continues, across its candidate targets
   * (`AffinityDecision.matchedSessionIds`). Recorded on the admission request
   * only; the lease of a granted candidate is joined to it to tell which warm
   * session an active lease is serving. Never read by admission.
   */
  warmSessionIds?: readonly string[];
  connectionOwner: string;
  deadlineAt: Date;
  candidates: readonly AdmissionCandidate[];
  /**
   * Re-anchors this attempt's schedule to an EARLIER attempt of the same
   * relay request and owner (saturation S-A retry rounds), so a retry reuses
   * the original database-clock spill instant and wait deadlines instead of
   * restarting them at this attempt's own clock (lock waits before this
   * attempt's transaction therefore never extend them). With an anchor,
   * candidate `notBeforeMs` count from the anchor attempt's enqueue instant,
   * the spill instant is at least anchor + `spillDelayMs`, and every
   * `waitBudgetMs` counts from that spill instant. Instants already in the
   * past are clamped to now: a past notBefore is no deferral, and a past
   * deadline means "admit only if free now". An unknown anchor (or one of
   * another request/owner) is ignored: the schedule then starts now.
   */
  schedule?: { anchorAttemptId: string; spillDelayMs: number };
  /**
   * Metric routing: when every candidate is metric-FULL, ignore metric FULL
   * and admit by leases only (default true). False only for an `:external`
   * caller's shortened local phase, which then goes external instead.
   */
  metricFailOpen?: boolean;
};

export type CapacityLeaseHandle = {
  /** Runtime-owned lifetime: aborts on client cancellation, loss, release or shutdown. */
  signal?: AbortSignal;
  leaseId: string;
  attemptId: string;
  capacityId: string;
  executionTargetId: string;
  poolMemberId?: string;
  fencingToken: bigint;
  expiresAt: Date;
  reservationClass?: number;
  borrowed?: boolean;
};

export type AdmissionResult =
  | { state: "ADMITTED"; lease: CapacityLeaseHandle }
  | { state: "WAITING"; requestId: string }
  | { state: "CANCELLED" | "EXPIRED" };

/**
 * Runtime-level outcome: a lease that was granted but lost before ownership
 * could be confirmed (F2-CAP-3). It is a server-side failure of THAT member's
 * lease, never a client cancellation, and it names the member so callers can
 * exclude it and fail over.
 */
export type CapacityLeaseLostAdmission = {
  state: "LEASE_LOST";
  reason: CapacityLeaseLostError;
  executionTargetId: string;
  poolMemberId?: string;
};

export type RuntimeAdmissionResult = AdmissionResult | CapacityLeaseLostAdmission;

export type AdmissionTerminalizationResult =
  | { state: "ADMITTED"; lease: CapacityLeaseHandle }
  | { state: "WAITING"; requestId: string }
  | { state: "CANCELLED" | "EXPIRED" | "TERMINAL" }
  | { state: "MISSING" };

export interface CapacityAdmissionStore {
  acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult>;
  /** Extend an active lease relative to the authoritative database clock. */
  heartbeat(lease: CapacityLeaseHandle, extensionMs: number): Promise<boolean>;
  release(lease: CapacityLeaseHandle): Promise<boolean>;
  terminalizeAttempt(
    attemptId: string,
    state: "CANCELLED" | "EXPIRED",
  ): Promise<AdmissionTerminalizationResult>;
  reclaimExpired(now: Date, limit: number): Promise<number>;
}

export function assertPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 31)
    throw new RangeError("Admission priority must be an integer from 0 through 31.");
  return priority;
}
