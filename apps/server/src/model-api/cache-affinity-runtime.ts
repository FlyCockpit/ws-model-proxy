import { sweepExpiredAffinity } from "./cache-affinity.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export function startCacheAffinityCleanup({
  intervalMs = SWEEP_INTERVAL_MS,
  sweep = sweepExpiredAffinity,
}: {
  intervalMs?: number;
  sweep?: typeof sweepExpiredAffinity;
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      let removed: number;
      do {
        removed = await sweep({ limit: 1000 });
      } while (removed === 1000);
    } catch (error) {
      console.error(
        "[cache-affinity] expired-record cleanup failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
