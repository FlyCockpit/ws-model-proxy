import type { CapacityAdmissionStore, CapacityLeaseHandle } from "./types.js";

export const reportCapacityCleanupFailure = (operation: "cancel" | "release", error: unknown) => {
  console.warn("[capacity] response lease cleanup failed", {
    operation,
    errorClass: error instanceof Error ? error.name : "UnknownError",
  });
};

export async function releaseCapacityLeaseWithRetry({
  store,
  lease,
}: {
  store: Pick<CapacityAdmissionStore, "release">;
  lease: CapacityLeaseHandle;
}): Promise<boolean> {
  let lastError: unknown;
  for (const retryDelayMs of [0, 25, 100, 250]) {
    if (retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      if (await store.release(lease)) return true;
      lastError = new Error("Capacity release was not acknowledged.");
    } catch (error) {
      lastError = error;
    }
  }
  reportCapacityCleanupFailure("release", lastError);
  return false;
}

/** One owner from admission through EOF. Response handoff never starts another timer. */
export class CapacityLeaseOwner {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeatRunning = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  readonly ready: Promise<void>;
  private releasePromise: Promise<boolean> | undefined;
  private stopped = false;
  private readonly abort = () => {
    void this.release(this.parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
  };

  constructor(
    private readonly store: Pick<CapacityAdmissionStore, "heartbeat" | "release">,
    private readonly lease: CapacityLeaseHandle,
    private readonly parentSignal?: AbortSignal,
    heartbeatIntervalMs = 10_000,
    private readonly leaseExtensionMs = 30_000,
    renewOnStart = false,
  ) {
    if (heartbeatIntervalMs > 0) {
      this.timer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
      this.timer.unref?.();
      this.watchOwnership(leaseExtensionMs);
    }
    parentSignal?.addEventListener("abort", this.abort, { once: true });
    if (parentSignal?.aborted) this.abort();
    this.ready = renewOnStart ? this.heartbeat() : Promise.resolve();
  }

  private watchOwnership(milliseconds: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => {
        void this.release(new Error("Capacity lease heartbeat timed out."));
      },
      Math.max(0, milliseconds),
    );
    this.watchdog.unref?.();
  }

  private async heartbeat() {
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    const startedAt = performance.now();
    try {
      const retained = await this.store.heartbeat(this.lease, this.leaseExtensionMs);
      if (this.stopped) return;
      if (!retained) void this.release(new Error("Capacity lease ownership was lost."));
      else {
        // Count from query START, not its response: a delayed DB result must
        // never extend local authority beyond the acknowledged database TTL.
        const remaining = this.leaseExtensionMs - (performance.now() - startedAt);
        if (remaining <= 0) void this.release(new Error("Capacity lease heartbeat timed out."));
        else this.watchOwnership(remaining);
      }
    } catch (error) {
      void this.release(error);
    } finally {
      this.heartbeatRunning = false;
    }
  }

  release(reason: unknown = new Error("Capacity lease released.")): Promise<boolean> {
    if (this.releasePromise) return this.releasePromise;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    this.parentSignal?.removeEventListener("abort", this.abort);
    // Assign before notifying listeners: response cleanup can re-enter release.
    this.releasePromise = Promise.resolve().then(() =>
      releaseCapacityLeaseWithRetry({ store: this.store, lease: this.lease }),
    );
    // Dispatch cancellation happens synchronously, before freeing the physical slot.
    this.controller.abort(reason);
    return this.releasePromise;
  }
}
