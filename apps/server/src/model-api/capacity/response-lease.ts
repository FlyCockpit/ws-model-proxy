import {
  CapacityLeaseOwner,
  reportCapacityCleanupFailure as reportCleanupFailure,
} from "./lease-owner.js";
import type { CapacityAdmissionStore, CapacityLeaseHandle } from "./types.js";

export { releaseCapacityLeaseWithRetry } from "./lease-owner.js";

export function holdCapacityLeaseForResponse({
  response,
  store,
  lease,
  signal,
  heartbeatIntervalMs = 10_000,
  leaseExtensionMs = 30_000,
  owner,
}: {
  response: Response;
  store: Pick<CapacityAdmissionStore, "heartbeat" | "release">;
  lease: CapacityLeaseHandle;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
  leaseExtensionMs?: number;
  owner?: CapacityLeaseOwner;
}): Response {
  if (!response.body)
    throw new Error("Bodyless capacity responses must release before returning to the client.");
  const lifetime =
    owner ?? new CapacityLeaseOwner(store, lease, signal, heartbeatIntervalMs, leaseExtensionMs);
  const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let finished = false;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let terminalError: unknown;
  const finish = async () => {
    if (finished) return;
    finished = true;
    lifetimeSignal.removeEventListener("abort", abort);
    await lifetime.release();
  };
  const reader = response.body.getReader();
  const loseLease = async (reason: unknown) => {
    if (finished) return;
    terminalError =
      reason instanceof Error
        ? reason
        : new Error("Capacity lease was lost while streaming.", { cause: reason });
    downstream?.error(terminalError);
    try {
      await reader.cancel(terminalError);
    } catch (error) {
      reportCleanupFailure("cancel", error);
    }
    await finish();
  };
  const abort = () => {
    void loseLease(lifetimeSignal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  lifetimeSignal.addEventListener("abort", abort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
      if (lifetimeSignal.aborted) abort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (terminalError) return;
        if (chunk.done) {
          // Do not expose downstream EOF until the durable release attempt has
          // finished. Closing first lets consumers resolve and processes move
          // on while the physical slot is still ACTIVE.
          await finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (!terminalError) controller.error(error);
        await finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch (error) {
        reportCleanupFailure("cancel", error);
      }
      await finish();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
