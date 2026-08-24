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
  let finished = false;
  let heartbeatRunning = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = async () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    await store.release(lease);
  };
  const heartbeat = async () => {
    if (finished || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const retained = await store.heartbeat(lease, new Date(Date.now() + leaseExtensionMs));
      if (!retained) await finish();
    } finally {
      heartbeatRunning = false;
    }
  };
  const reader = response.body?.getReader();
  const abort = () => {
    void reader?.cancel(signal?.reason).finally(finish);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (heartbeatIntervalMs > 0) timer = setInterval(() => void heartbeat(), heartbeatIntervalMs);

  if (!reader) {
    void finish();
    return response;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await finish();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
