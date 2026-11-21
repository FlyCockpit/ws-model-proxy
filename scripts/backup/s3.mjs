#!/usr/bin/env node
/**
 * Optional off-site copy of backup archives, using the dedicated BACKUP_S3_*
 * credentials only — never the app-upload key (S3_*), so a stolen app-upload
 * credential cannot read database dumps.
 *
 * CLI (used by pre-migrate.sh):
 *   node s3.mjs upload <file>   → uploads to <BACKUP_S3_PREFIX>/<file name> with a
 *                                 no-overwrite condition and prints the restore
 *                                 command for that exact object.
 *
 *   node s3.mjs check           → exits 1 with the reason when BACKUP_S3_* is invalid
 *                                 or the SDK cannot load (pre-migrate.sh runs it
 *                                 before connecting or dumping).
 *
 * restore.mjs imports describeObject/downloadObject directly.
 *
 * Rules are enforced here, when a dump is written or read — never in
 * packages/env: a backup-only misconfiguration must not crash-loop the app.
 * @aws-sdk/client-s3 is a root dependency (bundled in the image) but is imported
 * lazily, so local-only backups never load it.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Keep one part in flight; createReadStream bounds memory. 512 MiB parts keep
// a 5 TB object under the 10,000-part limit.
export const MULTIPART_PART_SIZE_BYTES = 512 * 1024 * 1024;
// A single conditional PutObject handles up to the common 5 GB limit.
export const MULTIPART_THRESHOLD_BYTES = 5_000_000_000;
export const MAX_MULTIPART_PARTS = 10_000;
export const S3_MAX_ATTEMPTS = 3;
export const S3_CONNECTION_TIMEOUT_MS = 30_000;
export const S3_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const S3_TRANSFER_DEADLINE_MS = 2 * 60 * 60 * 1000;
const S3_ABORT_DEADLINE_MS = 10_000;

/**
 * @typedef {{ ETag?: string, VersionId?: string, ContentLength?: number,
 *   LastModified?: Date, UploadId?: string, ServerSideEncryption?: string,
 *   SSECustomerAlgorithm?: string, Body?: import("node:stream").Readable }} S3Response
 * @typedef {{ send: (command: unknown, options?: { abortSignal: AbortSignal }) => Promise<S3Response>,
 *   destroy?: () => void }} BackupClient
 * @typedef {Record<string, new (input: Record<string, unknown>) => unknown>} BackupSdk
 */

/** One deadline covers requests, retries, identity checks and streaming bodies. */
async function withTransfer(client, owned, deadlineMs, operation) {
  const controller = new AbortController();
  const streams = new Set();
  const track = (stream) => {
    if (stream) {
      streams.add(stream);
      stream.once("close", () => streams.delete(stream));
      if (controller.signal.aborted) stream.destroy();
    }
    return stream;
  };
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Backup S3 transfer timed out after ${deadlineMs} ms.`);
      controller.abort(error);
      for (const stream of streams) stream.destroy();
      reject(error);
    }, deadlineMs);
  });
  const transfer = {
    signal: controller.signal,
    track,
    async send(command) {
      controller.signal.throwIfAborted();
      const body = track(command.input?.Body);
      try {
        const response = await client.send(command, { abortSignal: controller.signal });
        track(response.Body);
        controller.signal.throwIfAborted();
        return response;
      } finally {
        body?.destroy(); // failed/retried requests must never retain a file stream
      }
    },
  };
  try {
    return await Promise.race([operation(transfer), expired]);
  } finally {
    clearTimeout(timer);
    for (const stream of streams) stream.destroy();
    if (owned) client.destroy();
  }
}

/** Bounded memory, including the multipart ETag's concatenated part digests. */
async function fileETag(file, size, multipart, partSizeBytes, transfer) {
  const combined = createHash("md5");
  if (!multipart) {
    for await (const chunk of transfer.track(createReadStream(file))) combined.update(chunk);
    return combined.digest("hex");
  }
  const count = Math.ceil(size / partSizeBytes);
  for (let part = 0; part < count; part += 1) {
    transfer.signal.throwIfAborted();
    const hash = createHash("md5");
    const start = part * partSizeBytes;
    for await (const chunk of transfer.track(
      createReadStream(file, {
        start,
        end: Math.min(size, start + partSizeBytes) - 1,
      }),
    ))
      hash.update(chunk);
    combined.update(hash.digest());
  }
  return `${combined.digest("hex")}-${count}`;
}

async function sha256(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * @typedef {{
 *   bucket: string, prefix: string, region: string, endpoint: string | undefined,
 *   forcePathStyle: boolean, sse: boolean,
 *   credentials: { accessKeyId: string, secretAccessKey: string },
 * }} BackupS3Config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BackupS3Config}
 */
export function backupS3Config(env = process.env) {
  const bucket = env.BACKUP_S3_BUCKET;
  if (!bucket) throw new Error("BACKUP_S3_BUCKET is not set.");
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are missing. " +
        "Use a dedicated backup key (GetObject, GetObjectVersion, PutObject, AbortMultipartUpload), never S3_ACCESS_KEY_ID.",
    );
  }
  if (env.S3_ACCESS_KEY_ID && accessKeyId === env.S3_ACCESS_KEY_ID) {
    throw new Error(
      "BACKUP_S3_ACCESS_KEY_ID matches S3_ACCESS_KEY_ID. Backups need a distinct key so a stolen " +
        "app-upload credential cannot read database dumps.",
    );
  }
  const region = env.BACKUP_S3_REGION || "auto";
  // "auto" is a Cloudflare R2 convention; without an endpoint the SDK would
  // address the nonexistent host s3.auto.amazonaws.com.
  if (!env.BACKUP_S3_ENDPOINT && region === "auto") {
    throw new Error(
      'BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset (the default "auto" is an R2 convention).',
    );
  }
  const prefix = (env.BACKUP_S3_PREFIX ?? "database").replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("BACKUP_S3_PREFIX must not be empty.");
  return {
    bucket,
    prefix,
    region,
    endpoint: env.BACKUP_S3_ENDPOINT || undefined,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === "true",
    // R2 and several S3-compatible providers reject AWS SSE headers. Opt in for AWS.
    sse: env.BACKUP_S3_SSE === "AES256",
    credentials: { accessKeyId, secretAccessKey },
  };
}

/**
 * The image bundles the SDK; a source checkout without `pnpm install` gets the remedy.
 * @param {() => Promise<BackupSdk & Record<string, unknown>>} [load]
 */
export async function loadS3Sdk(load = () => import("@aws-sdk/client-s3")) {
  try {
    return await load();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") &&
      // Only the SDK itself: a broken install (one of its own dependencies
      // missing) keeps the original error.
      /['"]@aws-sdk\/client-s3['"]/.test(String("message" in error ? error.message : ""))
    ) {
      throw new Error(
        "S3 backups need @aws-sdk/client-s3, which is missing from this install (the image bundles it; in a checkout run pnpm install), or unset BACKUP_S3_BUCKET to use the local /backups volume",
        { cause: error },
      );
    }
    throw error;
  }
}

// The SDK's retry middleware warns this (on console, when the client has no
// logger) for every failed request with a streaming body, before rethrowing
// the error. Backup PUTs always stream, so a failed upload printed it once per
// attempt ahead of the real error. It carries no detail; the error itself
// still reaches the caller, which reports it (the FATAL / SCHEDULED BACKUP
// FAILED lines). Every other SDK warning still goes to the console.
// trace/debug/info/error stay silent exactly like the SDK's default no-op
// logger: its logger middleware sends every command's input and output to
// info and every failed command to error.
export const SDK_STREAMING_RETRY_WARNING =
  "An error was encountered in a non-retryable streaming request.";
export const backupS3Logger = {
  trace() {},
  debug() {},
  info() {},
  /** @param {...unknown} args */
  warn(...args) {
    if (args.length === 1 && args[0] === SDK_STREAMING_RETRY_WARNING) return;
    console.warn(...args);
  },
  error() {},
};

/** @param {BackupS3Config} config */
export async function createS3Client(config) {
  const { S3Client } = await loadS3Sdk();
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    // Stream retries are owned below so each attempt opens a fresh stream.
    maxAttempts: 1,
    logger: backupS3Logger,
    // The SDK accepts NodeHttpHandler options directly; no transitive import.
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      socketTimeout: S3_IDLE_TIMEOUT_MS,
    },
    // Flexible checksums stay at the SDK default: this client never presigns —
    // it uploads the real dump bytes itself, so the checksum covers the actual
    // body and gives the backup end-to-end integrity.
  });
}

/** @param {unknown} error */
function httpStatus(error) {
  return error && typeof error === "object" && "$metadata" in error
    ? /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (error).$metadata?.httpStatusCode
    : undefined;
}

/**
 * Retry transient failures only: no HTTP status (network, timeout), 408, 429,
 * and 5xx. Any other 4xx is the request's fault and fails at once.
 *
 * Any 412 verifies the existing object, including a later scheduler attempt.
 * With `confirmMissingUpload`, so does a 404 (CompleteMultipartUpload whose
 * earlier attempt completed but lost its response answers NoSuchUpload).
 * @template T
 * @param {{ send: (command: unknown) => Promise<T>, signal?: AbortSignal }} client
 * @param {() => unknown} makeCommand
 * @param {{ confirmWritten?: () => Promise<T | null>, confirmMissingUpload?: boolean }} [options]
 * @returns {Promise<T>}
 */
async function sendWithRetry(client, makeCommand, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= S3_MAX_ATTEMPTS; attempt += 1) {
    try {
      client.signal?.throwIfAborted();
      // A consumed ReadStream cannot be replayed, so build a new command each time.
      return await client.send(makeCommand());
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);
      if (status === 412 && options.confirmWritten) {
        const confirmed = await options.confirmWritten();
        if (confirmed) return confirmed;
      }
      if (status === 404 && attempt > 1 && options.confirmMissingUpload && options.confirmWritten) {
        // Only after a lost response: a first-attempt 404 is a real failure.
        const confirmed = await options.confirmWritten().catch((confirmError) => {
          if (httpStatus(confirmError) === 404) return null; // nothing there: keep the 404
          throw confirmError;
        });
        if (confirmed) return confirmed;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw error;
    }
  }
  throw lastError;
}

/**
 * Wrap a conditional-write rejection: some S3-compatible endpoints answer
 * If-None-Match with 400/405/501 instead of honoring it.
 * @param {unknown} error @param {string} operation
 */
function conditionalWriteError(error, operation) {
  const status = httpStatus(error);
  if (status === 400 || status === 405 || status === 501) {
    return new Error(
      `This S3 endpoint rejected ${operation} with If-None-Match (HTTP ${status}: ${error instanceof Error ? error.message : String(error)}); backups refuse to risk overwriting an object.`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Upload one verified archive under <prefix>/<file name>. Never overwrites an
 * existing object (If-None-Match: *), including on multipart completion.
 * @param {{
 *   file: string, config?: BackupS3Config, client?: BackupClient,
 *   sdk?: BackupSdk, multipartThresholdBytes?: number, partSizeBytes?: number, deadlineMs?: number,
 * }} options
 */
export async function uploadBackup({
  file,
  config = backupS3Config(),
  client,
  sdk,
  multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
  partSizeBytes = MULTIPART_PART_SIZE_BYTES,
  deadlineMs = S3_TRANSFER_DEADLINE_MS,
}) {
  const s3 = sdk ?? (await loadS3Sdk());
  const rawClient = client ?? (await createS3Client(config));
  return withTransfer(rawClient, !client, deadlineMs, async (s3Client) => {
    const size = (await stat(file)).size;
    const key = `${config.prefix}/${basename(file)}`;
    /** @type {Record<string, unknown>} */
    const base = { Bucket: config.bucket, Key: key, ContentType: "application/octet-stream" };
    if (config.sse) base.ServerSideEncryption = "AES256";
    /** @param {{ ETag?: string, VersionId?: string }} response */
    const result = (response) => ({
      bucket: config.bucket,
      key,
      eTag: response.ETag ?? null,
      versionId: response.VersionId ?? null,
    });
    let confirmedExisting = false;
    const confirmWritten = async () => {
      const head = await s3Client.send(
        new s3.HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      const different = () =>
        new Error(
          `A different object occupies s3://${config.bucket}/${key}; the existing backup was not overwritten.`,
        );
      if (head.ContentLength !== size) throw different();
      const multipart = size > multipartThresholdBytes;
      const expected = await fileETag(file, size, multipart, partSizeBytes, s3Client);
      const etag = head.ETag?.replace(/^"|"$/g, "");
      const predictable =
        etag &&
        /^[a-fA-F0-9]{32}(?:-\d+)?$/.test(etag) &&
        !head.ServerSideEncryption?.startsWith("aws:kms") &&
        !head.SSECustomerAlgorithm;
      if (!predictable || etag.toLowerCase() !== expected) {
        // Even a 32-hex provider tag can be opaque. A matching MD5 proves identity;
        // otherwise compare bytes before declaring a collision.
        // Provider/encryption ETags need not be MD5. Read that exact version and
        // compare SHA-256 without buffering a dump in memory or trusting its size.
        const remote = await s3Client.send(
          new s3.GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
            ...(head.ETag ? { IfMatch: head.ETag } : {}),
            ...(head.VersionId ? { VersionId: head.VersionId } : {}),
          }),
        );
        if (!remote.Body)
          throw new Error("Cannot verify existing backup: GetObject returned no body.");
        if (head.ETag && !sameETag(remote.ETag ?? null, head.ETag))
          throw new Error("The existing backup changed during verification.");
        const [localHash, remoteHash] = await Promise.all([
          sha256(s3Client.track(createReadStream(file))),
          sha256(remote.Body),
        ]);
        if (localHash !== remoteHash) throw different();
      }
      confirmedExisting = true;
      return { ETag: head.ETag, VersionId: head.VersionId };
    };

    if (size <= multipartThresholdBytes) {
      try {
        const response = await sendWithRetry(
          s3Client,
          () =>
            new s3.PutObjectCommand({ ...base, Body: createReadStream(file), IfNoneMatch: "*" }),
          { confirmWritten },
        );
        return result(response);
      } catch (error) {
        throw conditionalWriteError(error, "PutObject");
      }
    }

    const partCount = Math.ceil(size / partSizeBytes);
    if (partCount > MAX_MULTIPART_PARTS) {
      throw new Error(
        `Backup is ${size} bytes and needs ${partCount} parts; the S3 limit is ${MAX_MULTIPART_PARTS}.`,
      );
    }
    // Initiation is not retried: a lost response would leave an upload we cannot
    // abort. Configure a bucket lifecycle rule for incomplete multipart uploads.
    const create = await s3Client.send(new s3.CreateMultipartUploadCommand(base));
    if (!create.UploadId) throw new Error("S3 did not return an UploadId.");
    let completed = false;
    try {
      const parts = [];
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const start = (partNumber - 1) * partSizeBytes;
        const end = Math.min(size, start + partSizeBytes) - 1;
        const response = await sendWithRetry(
          s3Client,
          () =>
            new s3.UploadPartCommand({
              ...base,
              UploadId: create.UploadId,
              PartNumber: partNumber,
              Body: createReadStream(file, { start, end }),
              ContentLength: end - start + 1,
            }),
        );
        if (!response.ETag) throw new Error(`S3 did not return an ETag for part ${partNumber}.`);
        parts.push({ ETag: response.ETag, PartNumber: partNumber });
      }
      let complete;
      try {
        complete = await sendWithRetry(
          s3Client,
          () =>
            new s3.CompleteMultipartUploadCommand({
              ...base,
              UploadId: create.UploadId,
              MultipartUpload: { Parts: parts },
              IfNoneMatch: "*",
            }),
          { confirmWritten, confirmMissingUpload: true },
        );
      } catch (error) {
        throw conditionalWriteError(error, "CompleteMultipartUpload");
      }
      completed = true;
      return result(complete);
    } finally {
      if (!completed || confirmedExisting) {
        try {
          // The transfer may already be aborted; cleanup has its own short budget.
          await withTransfer(rawClient, false, S3_ABORT_DEADLINE_MS, (cleanup) =>
            sendWithRetry(
              cleanup,
              () => new s3.AbortMultipartUploadCommand({ ...base, UploadId: create.UploadId }),
            ),
          );
        } catch (error) {
          // 404 NoSuchUpload: nothing left to abort (it completed, as when
          // a lost completion response was confirmed above).
          if (httpStatus(error) !== 404) {
            console.error(
              `WARNING: could not abort incomplete multipart upload ${create.UploadId}; a bucket lifecycle rule should clean it up.`,
            );
          }
        }
      }
    }
  });
}

/**
 * HEAD an object and return its immutable identity.
 * @param {{ location: { bucket: string, key: string }, versionId?: string | null,
 *   config?: BackupS3Config, client?: BackupClient, sdk?: BackupSdk, deadlineMs?: number }} options
 */
export async function describeObject({
  location,
  versionId,
  config = backupS3Config(),
  client,
  sdk,
  deadlineMs = S3_TRANSFER_DEADLINE_MS,
}) {
  if (location.bucket !== config.bucket) {
    throw new Error(
      `Source bucket "${location.bucket}" is not BACKUP_S3_BUCKET ("${config.bucket}"). Restore reads only the configured backup bucket.`,
    );
  }
  const s3 = sdk ?? (await loadS3Sdk());
  const rawClient = client ?? (await createS3Client(config));
  return withTransfer(rawClient, !client, deadlineMs, async (s3Client) => {
    const head = await s3Client.send(
      new s3.HeadObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    );
    return {
      eTag: /** @type {string | null} */ (head.ETag ?? null),
      versionId: /** @type {string | null} */ (head.VersionId ?? null),
      size: /** @type {number | null} */ (head.ContentLength ?? null),
      lastModified: head.LastModified instanceof Date ? head.LastModified.toISOString() : null,
    };
  });
}

/** ETags are quoted on the wire; accept either spelling from the operator. */
export function sameETag(/** @type {string | null} */ a, /** @type {string | null} */ b) {
  if (!a || !b) return false;
  const bare = (/** @type {string} */ value) => value.replace(/^W\//, "").replace(/^"|"$/g, "");
  return bare(a) === bare(b);
}

/**
 * Download exactly the object identified by ETag (and version, if given).
 * GetObject carries If-Match, so a replaced object fails instead of downloading.
 * @param {{ location: { bucket: string, key: string }, eTag: string, versionId?: string | null,
 *   dest: string, config?: BackupS3Config, client?: BackupClient, sdk?: BackupSdk, deadlineMs?: number }} options
 */
export async function downloadObject({
  location,
  eTag,
  versionId,
  dest,
  config = backupS3Config(),
  client,
  sdk,
  deadlineMs = S3_TRANSFER_DEADLINE_MS,
}) {
  const s3 = sdk ?? (await loadS3Sdk());
  const rawClient = client ?? (await createS3Client(config));
  return withTransfer(rawClient, !client, deadlineMs, async (s3Client) => {
    const response = await s3Client.send(
      new s3.GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        IfMatch: eTag,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    );
    if (!response.Body)
      throw new Error(`s3://${location.bucket}/${location.key} returned an empty body.`);
    if (!sameETag(response.ETag ?? null, eTag)) {
      throw new Error("The object changed while it was being downloaded (ETag mismatch).");
    }
    await pipeline(response.Body, createWriteStream(dest, { mode: 0o600 }), {
      signal: s3Client.signal,
    });
  });
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "check") {
    try {
      // The settings first (no network): a bad BACKUP_S3_* fails before the
      // dump. Without a bucket (the image build) only the SDK is checked.
      if (process.env.BACKUP_S3_BUCKET) backupS3Config();
      await loadS3Sdk();
    } catch (error) {
      console.error(`FATAL: [backup] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }
  if (command !== "upload" || !file) {
    console.error("usage: node s3.mjs upload <file> | node s3.mjs check");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await uploadBackup({ file });
    console.log(`Uploaded backup to s3://${result.bucket}/${result.key}`);
    if (result.eTag) {
      const version = result.versionId ? ` --version-id ${result.versionId}` : "";
      console.log(
        `To restore it: restore s3://${result.bucket}/${result.key} --etag '${result.eTag}'${version} --confirm RESTORE:<database>`,
      );
    }
  } catch (error) {
    console.error(
      `FATAL: backup upload failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
