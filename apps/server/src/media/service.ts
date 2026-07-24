import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import defaultPrisma from "@ws-model-proxy/db";
import { MediaTypeNotAllowedError, sniffMediaMime } from "./sniff.js";
import type { MediaStore } from "./store.js";

/** Minimal Prisma surface this module touches — keeps tests easy to mock. */
type MediaPrisma = Pick<typeof defaultPrisma, "mediaAsset">;

/**
 * Thrown when a new upload would push the user's total UNEXPIRED asset bytes
 * past their quota. Distinct so routes can surface a clear 413-style / OpenAI
 * quota error instead of a generic failure. A dedup hit never reaches here (it
 * adds no new bytes).
 */
export class MediaQuotaExceededError extends Error {
  constructor(readonly quotaBytes: number) {
    super(
      `Upload rejected: it would exceed your media storage quota of ${quotaBytes} bytes. ` +
        "Delete or let existing uploads expire, or send this asset as a base64 data URL or external https URL.",
    );
    this.name = "MediaQuotaExceededError";
  }
}

export interface UploadedMedia {
  id: string;
  expiresAt: Date;
  mime: string;
  sizeBytes: number;
  /**
   * The persisted asset's real creation time. On a dedup hit this is the
   * ORIGINAL asset's createdAt (older than `now`), so callers that echo it back
   * stay consistent with what GET reports for the same id.
   */
  createdAt: Date;
  /** True when an identical unexpired upload by the same user was reused. */
  deduped: boolean;
}

/**
 * Stage bytes, sniff the type (allowlist only), run per-user sha256 dedup, and
 * persist metadata. The declared content-type is ignored except as a hint — the
 * stored mime is always the sniffed one.
 *
 * Dedup: if the same user already has an UNEXPIRED asset with identical bytes,
 * the staged copy is discarded and the existing asset's expiresAt is refreshed.
 */
export async function uploadMedia({
  source,
  userId,
  store,
  ttlHours,
  maxUploadBytes,
  maxBytesPerUser,
  prisma = defaultPrisma as unknown as MediaPrisma,
  now = new Date(),
}: {
  source: Readable;
  userId: string;
  store: MediaStore;
  ttlHours: number;
  /** Hard per-upload byte cap enforced WHILE streaming (defense in depth). */
  maxUploadBytes?: number;
  /** Per-user total-bytes quota; 0/undefined disables. Dedup hits are exempt. */
  maxBytesPerUser?: number;
  prisma?: MediaPrisma;
  now?: Date;
}): Promise<UploadedMedia> {
  const staged = await store.stage(source, { maxBytes: maxUploadBytes });

  const mime = sniffMediaMime(staged.header);
  if (!mime) {
    await staged.discard();
    throw new MediaTypeNotAllowedError();
  }

  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  // Per-user dedup on identical bytes with an unexpired asset.
  const existing = await prisma.mediaAsset.findFirst({
    where: { userId, sha256: staged.sha256, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, mime: true, sizeBytes: true, createdAt: true },
  });

  if (existing) {
    await staged.discard();
    await prisma.mediaAsset.update({ where: { id: existing.id }, data: { expiresAt } });
    return {
      id: existing.id,
      expiresAt,
      mime: existing.mime,
      sizeBytes: existing.sizeBytes,
      createdAt: existing.createdAt,
      deduped: true,
    };
  }

  // Per-user storage quota. Checked as late as sensible — the real size is known
  // now (post-staging) and a dedup hit already returned above, so a reused
  // upload never counts. Sum the user's UNEXPIRED bytes; reject and discard the
  // staged temp if this new upload would push them over. The check is not
  // serialized against concurrent uploads: N racing uploads can each pass and
  // overshoot the quota by up to (N-1) x MEDIA_MAX_UPLOAD_BYTES. Accepted — a
  // soft quota without row locking; TTL expiry reclaims the overshoot.
  if (typeof maxBytesPerUser === "number" && maxBytesPerUser > 0) {
    const agg = await prisma.mediaAsset.aggregate({
      where: { userId, expiresAt: { gt: now } },
      _sum: { sizeBytes: true },
    });
    const existingBytes = agg._sum.sizeBytes ?? 0;
    if (existingBytes + staged.sizeBytes > maxBytesPerUser) {
      await staged.discard();
      throw new MediaQuotaExceededError(maxBytesPerUser);
    }
  }

  // Commit bytes to their final path BEFORE writing the metadata row. The id is
  // generated here (not by the DB default) so we can name the object first. This
  // ordering guarantees a MediaAsset row never exists without its bytes: a
  // concurrent admin delete-all snapshots rows and deletes their files, so if it
  // races an in-flight upload it simply misses the not-yet-created row (row and
  // file both land afterward and GET works) instead of leaving a committed
  // object file that no row references and nothing ever reclaims.
  const id = randomUUID();
  await staged.commit(id);

  let asset: { id: string; createdAt: Date };
  try {
    asset = await prisma.mediaAsset.create({
      data: { id, userId, mime, sizeBytes: staged.sizeBytes, sha256: staged.sha256, expiresAt },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // The bytes are already committed but no row will point at them — best-effort
    // remove the object so it can't linger unreferenced.
    await store.delete(id).catch(() => {});
    throw err;
  }

  return {
    id: asset.id,
    expiresAt,
    mime,
    sizeBytes: staged.sizeBytes,
    createdAt: asset.createdAt,
    deduped: false,
  };
}
