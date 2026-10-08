/**
 * Needs-you e-mail scheduler (spec §7.4): runs `sweepNeedsYouMail` every minute. The sweep reads
 * nothing when SMTP is not configured, claims each need with a compare-and-set before it sends
 * (safe across replicas and overlapping runs), and is guarded so runs never overlap here.
 *
 * It owns no durable work at shutdown: stop() prevents future runs, and once the DB shutdown
 * fence is armed no run starts and a running sweep claims nothing more. A need not yet claimed
 * stays for the next process; one whose send was cut short may count as mailed.
 */
import { sweepNeedsYouMail } from "@ws-model-proxy/api/lib/needs-you-mail";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const NEEDS_YOU_MAIL_INTERVAL_MS = 60_000;

export function startNeedsYouMail({
  intervalMs = NEEDS_YOU_MAIL_INTERVAL_MS,
  sweep = sweepNeedsYouMail,
}: {
  intervalMs?: number;
  sweep?: () => Promise<number>;
} = {}): () => void {
  let running = false;
  const run = async () => {
    if (running || isDbShutdownFenceArmed()) return;
    running = true;
    try {
      await sweep();
    } catch (error) {
      // Class only: Prisma errors can carry SQL and parameters.
      console.error(
        "[needs-you] e-mail sweep failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
