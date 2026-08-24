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
  private lastMaintenanceAt = 0;
  constructor(
    private readonly store: CapacityAdmissionStore & {
      sweepAbandoned?: (input: {
        now: Date;
        heartbeatBefore: Date;
        limit: number;
      }) => Promise<unknown>;
    },
    private readonly pollIntervalMs = 100,
    private readonly maintenanceIntervalMs = 5_000,
  ) {}

  async acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult> {
    await this.maintain();
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

  async maintain(): Promise<void> {
    if (!this.store.sweepAbandoned) return;
    const nowMs = Date.now();
    if (nowMs - this.lastMaintenanceAt < this.maintenanceIntervalMs) return;
    this.lastMaintenanceAt = nowMs;
    const now = new Date(nowMs);
    await this.store.sweepAbandoned({
      now,
      heartbeatBefore: new Date(nowMs - 60_000),
      limit: 100,
    });
  }

  release(lease: CapacityLeaseHandle) {
    return this.store.release(lease);
  }

  hold(response: Response, lease: CapacityLeaseHandle, signal?: AbortSignal) {
    return holdCapacityLeaseForResponse({ response, store: this.store, lease, signal });
  }
}
