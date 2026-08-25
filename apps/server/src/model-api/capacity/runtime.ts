import { type CapacityWakeSource, waitWithCapacityPolling } from "./postgres-store.js";
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

// Polling re-enters store.acquire, which durably refreshes the WAITING request
// heartbeat. Keep this safely below the 60-second abandonment threshold.
export const MAX_CAPACITY_POLL_INTERVAL_MS = 10_000;

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
    private readonly wakeSource?: CapacityWakeSource,
  ) {
    if (
      !Number.isFinite(pollIntervalMs) ||
      pollIntervalMs < 1 ||
      pollIntervalMs > MAX_CAPACITY_POLL_INTERVAL_MS
    ) {
      throw new Error(
        `Capacity poll interval must be between 1 and ${MAX_CAPACITY_POLL_INTERVAL_MS} ms.`,
      );
    }
  }

  async acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult> {
    await this.maintain();
    const initial = await this.store.acquire(attempt, signal);
    const result =
      initial.state !== "WAITING"
        ? initial
        : await waitWithCapacityPolling({
            capacityIds: [...new Set(attempt.candidates.map(({ capacityId }) => capacityId))],
            deadlineAt: attempt.deadlineAt,
            signal,
            minimumPollMs: this.pollIntervalMs,
            maximumPollMs: this.pollIntervalMs,
            wakeSource: this.wakeSource,
            poll: () => this.store.acquire({ ...attempt, candidates: [] }, signal),
          });

    // The durable row, not the polling loop, is the source of truth. Terminalize
    // it before returning so a wakeup/poll on another server cannot admit this
    // attempt after its client has stopped waiting. If admission won the race,
    // release that lease immediately instead of leaking a slot.
    const terminal = signal?.aborted
      ? "CANCELLED"
      : Date.now() >= attempt.deadlineAt.getTime()
        ? "EXPIRED"
        : null;
    if (terminal) {
      if (result.state === "ADMITTED") await this.store.release(result.lease);
      else if (terminal === "CANCELLED") await this.store.cancelAttempt(attempt.attemptId);
      else await this.store.expireAttempt(attempt.attemptId);
      return { state: terminal };
    }
    if (result.state === "CANCELLED") await this.store.cancelAttempt(attempt.attemptId);
    if (result.state === "EXPIRED") await this.store.expireAttempt(attempt.attemptId);
    return result;
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
