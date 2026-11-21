import defaultPrisma from "@ws-model-proxy/db";
import { getMediaConfig } from "./config.js";
import { deleteExpiredMedia } from "./deletion.js";
import { LocalMediaStore, type MediaStore } from "./store.js";

type MediaPrisma = Pick<typeof defaultPrisma, "mediaAsset" | "$transaction">;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const SWEEP_BATCH = 500;
// Staged temp files this old are crashed-process leftovers (a live upload
// commits or discards within seconds), so they are safe to reclaim.
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

/**
 * Delete expired MediaAsset rows and their bytes. Returns the number of assets
 * removed. Logs counts ONLY — never ids, filenames, or any user data.
 */
export async function sweepExpiredMedia({
  store,
  prisma = defaultPrisma as unknown as MediaPrisma,
  now = new Date(),
}: {
  store: MediaStore;
  prisma?: MediaPrisma;
  now?: Date;
}): Promise<number> {
  let removed = 0;
  const skippedIds: string[] = [];
  // Batch to avoid loading an unbounded set of ids into memory.
  for (;;) {
    const expired = await prisma.mediaAsset.findMany({
      where: { expiresAt: { lte: now }, id: { notIn: skippedIds } },
      select: { id: true },
      take: SWEEP_BATCH,
    });
    if (expired.length === 0) break;

    for (const { id } of expired) {
      try {
        removed += await deleteExpiredMedia({ id, now, prisma, store });
      } catch {
        console.warn("[media] expired asset deletion failed; retained for retry.");
        skippedIds.push(id);
      }
    }

    if (expired.length < SWEEP_BATCH) break;
  }
  return removed;
}

/**
 * Start the in-process hourly sweep when media is configured. Returns a stop
 * function (used in tests / graceful shutdown), or null when media is off.
 */
export function startMediaCleanup(): (() => void) | null {
  const config = getMediaConfig();
  if (!config) return null;
  const store = new LocalMediaStore(config.root);

  const run = () => {
    void sweepExpiredMedia({ store })
      .then((removed) => {
        if (removed > 0) {
          console.log(`[media] cleanup swept ${removed} expired asset(s).`);
        }
      })
      .catch(() => {
        console.warn("[media] cleanup sweep failed.");
      });

    void store
      .sweepStaleTmp(STALE_TMP_MS)
      .then((removed) => {
        if (removed > 0) {
          console.log(`[media] cleanup removed ${removed} stale staging file(s).`);
        }
      })
      .catch(() => {
        console.warn("[media] cleanup stale-tmp sweep failed.");
      });
  };

  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the sweep.
  timer.unref?.();
  // Kick one sweep shortly after boot without blocking startup.
  setTimeout(run, 30_000).unref?.();

  return () => clearInterval(timer);
}
