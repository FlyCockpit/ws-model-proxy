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
  basePriority: number;
  connectionOwner: string;
  deadlineAt: Date;
  candidates: readonly AdmissionCandidate[];
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
