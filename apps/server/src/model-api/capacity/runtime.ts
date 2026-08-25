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

function waitForPollDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
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
    private readonly wakeSource?: CapacityWakeSource,
    private readonly now: () => number = Date.now,
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
    let result = await this.store.acquire(attempt, signal);
    let localDeadlineReached = false;
    while (result.state === "WAITING") {
      const terminal = signal?.aborted
        ? "CANCELLED"
        : localDeadlineReached || this.now() >= attempt.deadlineAt.getTime()
          ? "EXPIRED"
          : null;
      if (terminal) {
        const finalized = await this.store.terminalizeAttempt(attempt.attemptId, terminal);
        if (finalized.state === "ADMITTED") {
          await this.store.release(finalized.lease);
          return { state: terminal };
        }
        if (finalized.state !== "WAITING")
          return {
            state:
              finalized.state === "CANCELLED" || finalized.state === "EXPIRED"
                ? finalized.state
                : terminal,
          };

        // A fast process clock can reach the deadline before PostgreSQL does.
        // Avoid a tight terminalization loop while continuing to poll the
        // durable state until the database admits or expires the request.
        if (this.wakeSource)
          await this.wakeSource.wait(
            [...new Set(attempt.candidates.map(({ capacityId }) => capacityId))],
            this.pollIntervalMs,
            signal,
          );
        else await waitForPollDelay(this.pollIntervalMs, signal);
        result = await this.store.acquire({ ...attempt, candidates: [] }, signal);
        continue;
      }

      result = await waitWithCapacityPolling({
        capacityIds: [...new Set(attempt.candidates.map(({ capacityId }) => capacityId))],
        deadlineAt: attempt.deadlineAt,
        signal,
        minimumPollMs: this.pollIntervalMs,
        maximumPollMs: this.pollIntervalMs,
        wakeSource: this.wakeSource,
        poll: () => this.store.acquire({ ...attempt, candidates: [] }, signal),
      });
      // The polling deadline is a process-clock wake hint. Re-enter the loop
      // so EXPIRED is checked and committed against the database clock.
      if (result.state === "EXPIRED") {
        localDeadlineReached = true;
        result = { state: "WAITING", requestId: attempt.requestId };
      }
    }

    // The durable row, not the polling loop, is the source of truth. Terminalize
    // it before returning so a wakeup/poll on another server cannot admit this
    // attempt after its client has stopped waiting. If admission won the race,
    // release that lease immediately instead of leaking a slot.
    const terminal = signal?.aborted ? "CANCELLED" : null;
    if (terminal) {
      const finalized = await this.store.terminalizeAttempt(attempt.attemptId, terminal);
      // The terminalization transaction serializes with admission under the
      // same capacity locks. Its answer is authoritative even when our last
      // poll observed WAITING; release a lease that won that race.
      if (finalized.state === "ADMITTED") await this.store.release(finalized.lease);
      return { state: terminal };
    }
    if (result.state === "CANCELLED" || result.state === "EXPIRED") {
      const finalized = await this.store.terminalizeAttempt(attempt.attemptId, result.state);
      if (finalized.state === "ADMITTED") {
        await this.store.release(finalized.lease);
        return { state: result.state };
      }
    }
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
