import { MODEL_API_RELAY_TIMEOUT_MS } from "../limits.js";
import { CapacityLeaseLostError } from "./lease-loss.js";
import { currentCapacityRequestScope } from "./request-scope.js";
import type { CapacityAdmissionStore, CapacityLeaseHandle } from "./types.js";

export {
  type CapacityLeaseLossKind,
  CapacityLeaseLostError,
  capacityLeaseLostSignal,
  isCapacityLeaseLost,
} from "./lease-loss.js";

export const reportCapacityCleanupFailure = (operation: "cancel" | "release", error: unknown) => {
  console.warn("[capacity] response lease cleanup failed", {
    operation,
    errorClass: error instanceof Error ? error.name : "UnknownError",
  });
};

/**
 * Backstop only (F2-CAP-6): the longest any route may legitimately keep one
 * owner is one relay deadline plus response finalization. The request scope
 * is the primary structural guarantee; this cap covers owners created with no
 * scope (and scopes whose request never ends).
 */
export const CAPACITY_LEASE_MAX_LIFETIME_MS = MODEL_API_RELAY_TIMEOUT_MS + 60_000;

/** Backoff for a THROWN heartbeat (a `false` result is never retried). */
export const CAPACITY_HEARTBEAT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/**
 * A retry is scheduled only while the acknowledged TTL still covers the delay
 * plus this margin, which leaves room for the retry query itself. The watchdog
 * remains the hard bound either way.
 */
export const CAPACITY_HEARTBEAT_RETRY_MARGIN_MS = 2_000;

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
  private lifetimeCap: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic instant (performance.now) at which the acknowledged TTL ends. */
  private acknowledgedUntil: number;
  /** Wakes a heartbeat retry backoff early when the owner stops. */
  private wakeRetry: (() => void) | undefined;
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
    maxLifetimeMs = CAPACITY_LEASE_MAX_LIFETIME_MS,
  ) {
    this.acknowledgedUntil = performance.now() + leaseExtensionMs;
    if (heartbeatIntervalMs > 0) {
      this.timer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
      this.timer.unref?.();
      this.watchOwnership(leaseExtensionMs);
    }
    if (maxLifetimeMs > 0 && Number.isFinite(maxLifetimeMs)) {
      this.lifetimeCap = setTimeout(() => {
        console.warn("[capacity] lease owner exceeded its maximum lifetime; releasing");
        void this.release(new CapacityLeaseLostError("max_lifetime"));
      }, maxLifetimeMs);
      this.lifetimeCap.unref?.();
    }
    // Structural release guard: an owner created while a request scope is
    // active is released when that scope closes, even if the route forgot to.
    currentCapacityRequestScope()?.register(this);
    parentSignal?.addEventListener("abort", this.abort, { once: true });
    if (parentSignal?.aborted) this.abort();
    this.ready = renewOnStart ? this.heartbeat() : Promise.resolve();
  }

  get released(): boolean {
    return this.stopped;
  }

  private watchOwnership(milliseconds: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => {
        void this.release(new CapacityLeaseLostError("heartbeat_timeout"));
      },
      Math.max(0, milliseconds),
    );
    this.watchdog.unref?.();
  }

  private waitForRetry(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, milliseconds);
      timeout.unref?.();
      function finish() {
        clearTimeout(timeout);
        resolve();
      }
      this.wakeRetry = finish;
    }).finally(() => {
      this.wakeRetry = undefined;
    });
  }

  private async heartbeat() {
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    try {
      for (let retry = 0; ; retry++) {
        const startedAt = performance.now();
        let retained: boolean;
        try {
          retained = await this.store.heartbeat(this.lease, this.leaseExtensionMs);
        } catch (error) {
          if (this.stopped) return;
          // F2-CAP-5: one transient error must not abort the dispatch. Retry
          // within the TTL the database last ACKNOWLEDGED; an error never
          // extends or re-arms the watchdog, so authority still ends there.
          const delay =
            CAPACITY_HEARTBEAT_RETRY_DELAYS_MS[
              Math.min(retry, CAPACITY_HEARTBEAT_RETRY_DELAYS_MS.length - 1)
            ]!;
          const remaining = this.acknowledgedUntil - performance.now();
          if (remaining <= delay + CAPACITY_HEARTBEAT_RETRY_MARGIN_MS) {
            void this.release(new CapacityLeaseLostError("heartbeat_failed", { cause: error }));
            return;
          }
          await this.waitForRetry(delay);
          if (this.stopped) return;
          continue;
        }
        if (this.stopped) return;
        // A false result means the row was reclaimed or fenced: never retried.
        if (!retained) {
          void this.release(new CapacityLeaseLostError("ownership_lost"));
          return;
        }
        // Count from query START, not its response: a delayed DB result must
        // never extend local authority beyond the acknowledged database TTL.
        const acknowledgedUntil = startedAt + this.leaseExtensionMs;
        const remaining = acknowledgedUntil - performance.now();
        if (remaining <= 0) {
          void this.release(new CapacityLeaseLostError("heartbeat_timeout"));
          return;
        }
        this.acknowledgedUntil = acknowledgedUntil;
        this.watchOwnership(remaining);
        return;
      }
    } finally {
      this.heartbeatRunning = false;
    }
  }

  release(reason: unknown = new Error("Capacity lease released.")): Promise<boolean> {
    if (this.releasePromise) return this.releasePromise;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    clearTimeout(this.lifetimeCap);
    this.wakeRetry?.();
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
