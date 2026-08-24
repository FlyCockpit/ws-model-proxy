import { waitWithCapacityPolling } from "./postgres-store.js";
import { holdCapacityLeaseForResponse } from "./response-lease.js";
import type {
  AdmissionAttempt,
  AdmissionResult,
  CapacityAdmissionStore,
  CapacityLeaseHandle,
} from "./types.js";

export interface CapacityAdmissionRuntime {
  acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult>;
  release(lease: CapacityLeaseHandle): Promise<boolean>;
  hold(response: Response, lease: CapacityLeaseHandle, signal?: AbortSignal): Response;
}

export class StoreCapacityAdmissionRuntime implements CapacityAdmissionRuntime {
  constructor(
    private readonly store: CapacityAdmissionStore,
    private readonly pollIntervalMs = 100,
  ) {}

  async acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult> {
    const initial = await this.store.acquire(attempt, signal);
    if (initial.state !== "WAITING") return initial;
    return waitWithCapacityPolling({
      capacityIds: [...new Set(attempt.candidates.map(({ capacityId }) => capacityId))],
      deadlineAt: attempt.deadlineAt,
      signal,
      minimumPollMs: this.pollIntervalMs,
      maximumPollMs: this.pollIntervalMs,
      poll: () => this.store.acquire({ ...attempt, candidates: [] }, signal),
    });
  }

  release(lease: CapacityLeaseHandle) {
    return this.store.release(lease);
  }

  hold(response: Response, lease: CapacityLeaseHandle, signal?: AbortSignal) {
    return holdCapacityLeaseForResponse({ response, store: this.store, lease, signal });
  }
}
