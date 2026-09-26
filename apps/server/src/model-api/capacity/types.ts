export type AdmissionCandidate = {
  capacityId: string;
  executionTargetId: string;
  poolMemberId?: string;
  candidateOrder: number;
  /** Candidate-local absolute upper bound; sibling candidates may remain eligible longer. */
  deadlineAt?: Date;
  /**
   * Candidate wait budget in milliseconds, measured on the DATABASE clock
   * when the attempt is first persisted: the effective deadline is
   * min(deadlineAt ?? attempt.deadlineAt, db_now + waitBudgetMs). 0 means
   * "admit only if free in the creating transaction, else expire". Undefined
   * or null means no budget (only the absolute bound applies).
   */
  waitBudgetMs?: number | null;
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
