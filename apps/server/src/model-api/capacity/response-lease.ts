import type { CapacityAdmissionStore, CapacityLeaseHandle } from "./types.js";

export function holdCapacityLeaseForResponse({
  response,
  store,
  lease,
  signal,
  heartbeatIntervalMs = 10_000,
  leaseExtensionMs = 30_000,
}: {
  response: Response;
  store: Pick<CapacityAdmissionStore, "heartbeat" | "release">;
  lease: CapacityLeaseHandle;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
  leaseExtensionMs?: number;
}): Response {
  const reportCleanupFailure = (operation: "cancel" | "release", error: unknown) => {
    // Never include arbitrary upstream/driver messages: they may contain request
    // or credential material. The operation and error class are sufficient for
    // an operator to correlate cleanup failures with service telemetry.
    console.warn("[capacity] response lease cleanup failed", {
      operation,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  };
  let finished = false;
  let heartbeatRunning = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let terminalError: unknown;
  const finish = async () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    try {
      await store.release(lease);
    } catch (error) {
      reportCleanupFailure("release", error);
    }
  };
  const heartbeat = async () => {
    if (finished || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const retained = await store.heartbeat(lease, leaseExtensionMs);
      if (!retained) await loseLease(new Error("Capacity lease was lost while streaming."));
    } catch (error) {
      await loseLease(error);
    } finally {
      heartbeatRunning = false;
    }
  };
  const reader = response.body?.getReader();
  const loseLease = async (reason: unknown) => {
    if (finished) return;
    terminalError =
      reason instanceof Error
        ? reason
        : new Error("Capacity lease was lost while streaming.", { cause: reason });
    downstream?.error(terminalError);
    try {
      await reader?.cancel(terminalError);
    } catch (error) {
      reportCleanupFailure("cancel", error);
    }
    await finish();
  };
  const abort = () => {
    void loseLease(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (heartbeatIntervalMs > 0) timer = setInterval(() => void heartbeat(), heartbeatIntervalMs);

  if (!reader) {
    void finish();
    return response;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (terminalError) return;
        if (chunk.done) {
          controller.close();
          await finish();
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
