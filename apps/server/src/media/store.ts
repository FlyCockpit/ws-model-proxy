import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SNIFF_HEADER_BYTES } from "./sniff.js";

/**
 * A blob written to a temp location, hashed and sized, but not yet committed to
 * its final id-derived path. Lets the caller sniff/validate and run per-user
 * sha256 dedup BEFORE deciding whether to keep the bytes.
 */
export interface StagedObject {
  sha256: string;
  sizeBytes: number;
  /** First bytes of the stream, for magic-byte sniffing. */
  header: Buffer;
  /** Move the temp file to the final path for `id`. Consumes the staged object. */
  commit(id: string): Promise<void>;
  /** Delete the temp file (dedup hit, or rejected type). Idempotent. */
  discard(): Promise<void>;
}

export interface MediaObjectStream {
  stream: Readable;
  sizeBytes: number;
}

/** Options for staging: enforce an upstream byte cap while streaming. */
export interface StageOptions {
  /**
   * Abort staging once the source exceeds this many bytes, destroying the
   * pipeline and cleaning the temp file. Defense in depth behind the route
   * bodyLimit — protects future/mis-ordered callers. Omit/0 to not cap here.
   */
  maxBytes?: number;
}

/**
 * Thrown by stage() when the streamed source exceeds the configured maxBytes.
 * Distinct so routes can map it to their existing oversize responses rather
 * than a generic 500.
 */
export class MediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("Upload exceeds the maximum allowed size.");
    this.name = "MediaTooLargeError";
  }
}

/**
 * Storage backend for media bytes. Postgres holds only metadata; this owns the
 * bytes. The local implementation writes under MEDIA_ROOT; a future S3/R2
 * backend implements the same interface without touching the routes.
 */
export interface MediaStore {
  stage(source: Readable, options?: StageOptions): Promise<StagedObject>;
  getStream(id: string): Promise<MediaObjectStream | null>;
  delete(id: string): Promise<void>;
  /**
   * Delete staged temp files older than `olderThanMs` (crashed-upload leftovers
   * that stage() wrote but never committed or discarded). Returns the count
   * removed. Fresh, in-flight staging files must survive.
   */
  sweepStaleTmp(olderThanMs: number): Promise<number>;
}

// IDs are cuid2 (a-z0-9). We allow `-` and `_` too so callers can use readable
// ids, while still forbidding path separators, `.` (traversal), and anything
// else that could escape the objects directory.
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

// Upper bound on id length. Real ids are UUIDs/cuid2 (~24-36 chars); anything
// far longer is a probe. Bounding it keeps a hostile id out of paths and logs.
export const MAX_MEDIA_ID_LENGTH = 128;

/**
 * Route-boundary id validation. Routes call this BEFORE touching the store so an
 * unsafe id (path traversal, overlong, empty) becomes a clean 404/400 instead
 * of an unhandled 500 from assertSafeId deep in the store. assertSafeId remains
 * the store's last line of defense for any caller that skips this.
 */
export function isSafeMediaId(id: string | undefined | null): id is string {
  return (
    typeof id === "string" && id.length > 0 && id.length <= MAX_MEDIA_ID_LENGTH && SAFE_ID.test(id)
  );
}

function assertSafeId(id: string): void {
  if (!isSafeMediaId(id)) {
    throw new Error("Refusing to derive a media path from an unsafe id.");
  }
}

export class LocalMediaStore implements MediaStore {
  constructor(private readonly root: string) {}

  private get objectsDir(): string {
    return join(this.root, "objects");
  }

  private get tmpDir(): string {
    return join(this.root, "tmp");
  }

  /** Final path for an id, sharded by its first two chars. No user input. */
  private objectPath(id: string): string {
    assertSafeId(id);
    return join(this.objectsDir, id.slice(0, 2), id);
  }

  async stage(source: Readable, options: StageOptions = {}): Promise<StagedObject> {
    await mkdir(this.tmpDir, { recursive: true });
    const tmpPath = join(this.tmpDir, `stage-${randomBytes(16).toString("hex")}`);

    const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : undefined;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const headerChunks: Buffer[] = [];
    let headerLen = 0;

    // Tee the stream through a Transform: hash + size + header capture while
    // passing bytes through to the write stream. Driving it with stream.pipeline
    // gives real backpressure — a slow disk pauses `source` instead of buffering
    // the whole upload in memory — plus unified error propagation and teardown.
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        // Enforce the byte cap AS bytes stream in — abort before the whole
        // oversize payload is written or hashed. pipeline() tears down source +
        // write stream on this error; the catch below removes the temp file.
        if (maxBytes !== undefined && sizeBytes > maxBytes) {
          callback(new MediaTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        if (headerLen < SNIFF_HEADER_BYTES) {
          const need = SNIFF_HEADER_BYTES - headerLen;
          const slice = chunk.length > need ? chunk.subarray(0, need) : chunk;
          headerChunks.push(Buffer.from(slice));
          headerLen += slice.length;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, inspect, createWriteStream(tmpPath));
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const header = Buffer.concat(headerChunks);
    const sha256 = hash.digest("hex");
    let settled = false;

    const discard = async () => {
      if (settled) return;
      settled = true;
      await rm(tmpPath, { force: true }).catch(() => {});
    };

    return {
      sha256,
      sizeBytes,
      header,
      discard,
      commit: async (id: string) => {
        if (settled) throw new Error("Staged object already committed or discarded.");
        settled = true;
        const dest = this.objectPath(id);
        try {
          await mkdir(join(this.objectsDir, id.slice(0, 2)), { recursive: true });
          await rename(tmpPath, dest);
        } catch (err) {
          // settled is already true, so the caller's discard() is now a no-op.
          // Remove the temp file here (best-effort) so a failed rename — disk
          // full, permissions, cross-device — never orphans it under tmp/,
          // which the sweep does not touch.
          await rm(tmpPath, { force: true }).catch(() => {});
          throw err;
        }
      },
    };
  }

  async getStream(id: string): Promise<MediaObjectStream | null> {
    const path = this.objectPath(id);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { stream: createReadStream(path), sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.objectPath(id), { force: true }).catch(() => {});
  }

  async sweepStaleTmp(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const entries = await readdir(this.tmpDir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of entries) {
      const path = join(this.tmpDir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        removed += 1;
      } catch {
        // Racing commit/discard may remove the file first — ignore and move on.
      }
    }
    return removed;
  }
}
