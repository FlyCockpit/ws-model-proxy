export type AdmissionState = "WAITING" | "ADMITTED" | "CANCELLED" | "EXPIRED" | "TERMINAL";
export type WaiterState = "WAITING" | "WON" | "CANCELLED" | "EXPIRED";
export type LeaseState = "ACTIVE" | "RELEASED" | "EXPIRED" | "RECLAIMED";

export type AdmissionCandidate = {
  capacityId: string;
  executionTargetId: string;
  poolMemberId?: string;
  candidateOrder: number;
};

export type AdmissionAttempt = {
  attemptId: string;
  requestId: string;
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
};

export type AdmissionResult =
  | { state: "ADMITTED"; lease: CapacityLeaseHandle }
  | { state: "WAITING"; requestId: string }
  | { state: "CANCELLED" | "EXPIRED" };

export interface CapacityAdmissionStore {
  acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult>;
  heartbeat(lease: CapacityLeaseHandle, expiresAt: Date): Promise<boolean>;
  release(lease: CapacityLeaseHandle): Promise<boolean>;
  cancelAttempt(attemptId: string): Promise<boolean>;
  reclaimExpired(now: Date, limit: number): Promise<number>;
}

export function assertPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 31)
    throw new RangeError("Admission priority must be an integer from 0 through 31.");
  return priority;
}
