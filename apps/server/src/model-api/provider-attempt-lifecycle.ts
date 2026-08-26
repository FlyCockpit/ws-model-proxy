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
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await expire();
    } catch {
      console.warn("[provider-attempt] expiry sweep failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  void run();
  return () => clearInterval(timer);
}
