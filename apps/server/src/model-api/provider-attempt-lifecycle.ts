import { createSerialTask } from "../serial-task.js";
import { expireProviderAttempts } from "./provider-attempt-runtime.js";

const EXPIRY_INTERVAL_MS = 5_000;

/** Provider attempts exist only on the public-egress path. */
export function providerAttemptExpiryEnabled(publicEgressEnabled: boolean): boolean {
  return publicEgressEnabled;
}

/**
 * Starts provider-attempt crash recovery independently of local-capacity
 * admission. Public egress can be enabled without the global capacity gate.
 */
export function startProviderAttemptExpiry(
  expire: () => Promise<unknown> = expireProviderAttempts,
  intervalMs = EXPIRY_INTERVAL_MS,
): () => void {
  // A sweep that is still running when the interval fires is not queued again.
  const task = createSerialTask({
    run: expire,
    overlap: "drop",
    intervalMs,
    onError: () => console.warn("[provider-attempt] expiry sweep failed"),
  });
  task.start();
  return () => void task.stop();
}
