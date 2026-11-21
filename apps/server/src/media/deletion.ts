import type defaultPrisma from "@ws-model-proxy/db";
import type { MediaStore } from "./store.js";

/**
 * The conditional delete locks the expired row until unlink completes. Refreshes
 * either win first (count 0) or wait and find no row. An unlink failure rolls the
 * delete back, preserving metadata for a later retry.
 */
export function deleteExpiredMedia({
  id,
  now,
  prisma,
  store,
}: {
  id: string;
  now: Date;
  prisma: Pick<typeof defaultPrisma, "$transaction">;
  store: MediaStore;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.mediaAsset.deleteMany({
      where: { id, expiresAt: { lte: now } },
    });
    if (count > 0) await store.delete(id);
    return count;
  });
}
