import defaultPrisma from "@ws-model-proxy/db";
import type { MediaStore } from "./store.js";

type MediaPrisma = Pick<typeof defaultPrisma, "mediaAsset">;

const DELETE_BATCH = 500;

export interface MediaStats {
  /** Total number of stored asset metadata rows. */
  assetCount: number;
  /** Sum of sizeBytes across all rows. */
  totalBytes: number;
  /** Rows whose expiresAt has passed but that the sweep hasn't reclaimed yet. */
  expiredCount: number;
}

/**
 * Aggregate-only media stats for the admin dashboard: counts and total bytes.
 * Never returns ids, owners, mimes, or anything that could open content —
 * metadata/policy visibility only, per the asset plan's admin authorization rules.
 */
export async function getMediaStats({
  prisma = defaultPrisma as unknown as MediaPrisma,
  now = new Date(),
}: {
  prisma?: MediaPrisma;
  now?: Date;
} = {}): Promise<MediaStats> {
  const [aggregate, expiredCount] = await Promise.all([
    prisma.mediaAsset.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
    prisma.mediaAsset.count({ where: { expiresAt: { lte: now } } }),
  ]);

  return {
    assetCount: aggregate._count._all,
    totalBytes: aggregate._sum.sizeBytes ?? 0,
    expiredCount,
  };
}

export interface DeleteAllResult {
  /** Number of asset rows removed. */
  removed: number;
  /** Sum of sizeBytes of the removed rows. */
  bytes: number;
}

/**
 * Delete EVERY media asset — bytes first, then metadata rows — in batches.
 * Danger-zone reset for reclaiming disk. Returns counts only (rows + bytes) so
 * the caller can audit-log without ever touching content or filenames.
 */
export async function deleteAllMedia({
  store,
  prisma = defaultPrisma as unknown as MediaPrisma,
}: {
  store: MediaStore;
  prisma?: MediaPrisma;
}): Promise<DeleteAllResult> {
  let removed = 0;
  let bytes = 0;

  for (;;) {
    const batch = await prisma.mediaAsset.findMany({
      select: { id: true, sizeBytes: true },
      take: DELETE_BATCH,
    });
    if (batch.length === 0) break;

    for (const { id } of batch) {
      await store.delete(id);
    }
    await prisma.mediaAsset.deleteMany({ where: { id: { in: batch.map((a) => a.id) } } });

    removed += batch.length;
    bytes += batch.reduce((sum, a) => sum + a.sizeBytes, 0);

    if (batch.length < DELETE_BATCH) break;
  }

  return { removed, bytes };
}
