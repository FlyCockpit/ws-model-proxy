export type AdmissionCandidate = {
  capacityId: string;
  executionTargetId: string;
  poolMemberId?: string;
  candidateOrder: number;
  /** Candidate-local deadline; sibling candidates may remain eligible longer. */
  deadlineAt?: Date;
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
