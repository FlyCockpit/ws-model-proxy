import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  backupS3Config,
  backupS3Logger,
  createS3Client,
  describeObject,
  downloadObject,
  loadS3Sdk,
  SDK_STREAMING_RETRY_WARNING,
  sameETag,
  uploadBackup,
} from "./s3.mjs";

const baseEnv = {
  BACKUP_S3_BUCKET: "backups",
  BACKUP_S3_ACCESS_KEY_ID: "backup-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret",
  BACKUP_S3_REGION: "us-east-1",
};

/** Inert SDK stand-in: each command records its input; no network. */
const sdk = Object.fromEntries(
  [
    "PutObjectCommand",
    "CreateMultipartUploadCommand",
    "UploadPartCommand",
    "CompleteMultipartUploadCommand",
    "AbortMultipartUploadCommand",
    "HeadObjectCommand",
    "GetObjectCommand",
  ].map((name) => [
    name,
    class {
      /** @param {Record<string, unknown>} input */
      constructor(input) {
        this.name = name;
        this.input = input;
      }
    },
  ]),
);

/** @param {(command: { name: string, input: Record<string, unknown> }) => unknown} respond */
function fakeClient(respond) {
  /** @type {Array<{ name: string, input: Record<string, unknown> }>} */
  const sent = [];
  return {
    sent,
    /** @param {{ name: string, input: Record<string, unknown> }} command */
    async send(command) {
      sent.push(command);
      return respond(command);
    },
  };
}

describe("backupS3Config", () => {
  it("returns a normalized config", () => {
    const config = backupS3Config({ ...baseEnv, BACKUP_S3_PREFIX: "/db/" });
    assert.equal(config.prefix, "db");
    assert.equal(config.sse, false);
  });
  it("refuses unsafe or unusable settings", () => {
    assert.throws(() => backupS3Config({}), /BACKUP_S3_BUCKET/);
    assert.throws(() => backupS3Config({ BACKUP_S3_BUCKET: "b" }), /ACCESS_KEY/);
    assert.throws(
      () => backupS3Config({ ...baseEnv, S3_ACCESS_KEY_ID: "backup-key" }),
      /distinct key/,
    );
    assert.throws(() => backupS3Config({ ...baseEnv, BACKUP_S3_REGION: "" }), /real AWS region/);
    assert.throws(() => backupS3Config({ ...baseEnv, BACKUP_S3_PREFIX: "/" }), /must not be empty/);
  });
});

describe("S3 transfer", () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-s3-test-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads with a no-overwrite condition under the prefix", async () => {
    const file = join(dir, "pre-migrate-20261103T000000Z.dump");
    await writeFile(file, "PGDMP-data");
    const client = fakeClient(() => ({ ETag: '"e1"', VersionId: "v1" }));
    const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
    assert.deepEqual(result, {
      bucket: "backups",
      key: "database/pre-migrate-20261103T000000Z.dump",
      eTag: '"e1"',
      versionId: "v1",
    });
    assert.equal(client.sent[0]?.name, "PutObjectCommand");
    assert.equal(client.sent[0]?.input.IfNoneMatch, "*");
  });

  it("uses conditional multipart completion above the threshold and aborts on failure", async () => {
    const file = join(dir, "big.dump");
    await writeFile(file, "0123456789");
    const ok = fakeClient((command) =>
      command.name === "CreateMultipartUploadCommand" ? { UploadId: "u1" } : { ETag: '"p"' },
    );
    await uploadBackup({
      file,
      config: backupS3Config(baseEnv),
      client: ok,
      sdk,
      multipartThresholdBytes: 4,
      partSizeBytes: 4,
    });
    assert.deepEqual(
      ok.sent.map((command) => command.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "CompleteMultipartUploadCommand",
      ],
    );
    assert.equal(ok.sent.at(-1)?.input.IfNoneMatch, "*");

    const failing = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u2" };
      if (command.name === "CompleteMultipartUploadCommand")
        throw Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 501 } });
      return { ETag: '"p"' };
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: failing,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      /refuse to risk overwriting/,
    );
    assert.equal(failing.sent.at(-1)?.name, "AbortMultipartUploadCommand");
  });

  const statusError = (status) =>
    Object.assign(new Error(`http ${status}`), { $metadata: { httpStatusCode: status } });
  const networkError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  it("retries transient failures but not a client error", async () => {
    const file = join(dir, "retry.dump");
    await writeFile(file, "PGDMP-data");
    for (const transient of [503, 429, 408]) {
      let calls = 0;
      const client = fakeClient(() => {
        calls += 1;
        if (calls === 1) throw statusError(transient);
        return { ETag: '"ok"' };
      });
      const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
      assert.equal(result.eTag, '"ok"');
      assert.equal(calls, 2, `retried after ${transient}`);
    }
    const forbidden = fakeClient(() => {
      throw statusError(403);
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: forbidden, sdk }),
      /http 403/,
    );
    assert.equal(forbidden.sent.length, 1, "a 403 is not retried");
  });

  const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
  const conflictClient = (head, body, failFirst = false) => {
    let puts = 0;
    return fakeClient((command) => {
      if (command.name === "HeadObjectCommand") return head();
      if (command.name === "GetObjectCommand") return { ETag: head().ETag, Body: body() };
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u" };
      if (command.name === "UploadPartCommand") return { ETag: '"part"' };
      if (command.name === "AbortMultipartUploadCommand") return {};
      puts += 1;
      if (puts === 1 && failFirst) throw networkError();
      throw statusError(412);
    });
  };

  it("accepts an immediate 412 only when size AND single-part content identity match", async () => {
    const file = join(dir, "existing.dump");
    await writeFile(file, "PGDMP-data");
    for (const failFirst of [false, true]) {
      const client = conflictClient(
        () => ({ ContentLength: 10, ETag: `"${md5("PGDMP-data")}"`, VersionId: "v9" }),
        null,
        failFirst,
      );
      const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
      assert.equal(result.versionId, "v9");
      assert.equal(client.sent.at(-1).name, "HeadObjectCommand");
      assert.equal(
        client.sent.filter((c) => c.name === "PutObjectCommand").length,
        failFirst ? 2 : 1,
      );
    }
  });

  it("computes the multipart ETag using the uploader's part boundaries and aborts the redundant upload", async () => {
    const file = join(dir, "existing-multipart.dump");
    await writeFile(file, "0123456789");
    const etag = `${md5(Buffer.concat(["0123", "4567", "89"].map((part) => Buffer.from(md5(part), "hex"))))}-3`;
    const client = conflictClient(() => ({ ContentLength: 10, ETag: `"${etag}"` }));
    const result = await uploadBackup({
      file,
      config: backupS3Config(baseEnv),
      client,
      sdk,
      multipartThresholdBytes: 4,
      partSizeBytes: 4,
    });
    assert.equal(result.eTag, `"${etag}"`);
    assert.equal(client.sent.at(-1).name, "AbortMultipartUploadCommand");
  });

  it("accepts a completed multipart upload whose completion response was lost (404 on retry)", async () => {
    const file = join(dir, "lost-complete.dump");
    await writeFile(file, "0123456789");
    const etag = `${md5(Buffer.concat(["0123", "4567", "89"].map((part) => Buffer.from(md5(part), "hex"))))}-3`;
    let completes = 0;
    const client = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u" };
      if (command.name === "UploadPartCommand") return { ETag: '"part"' };
      if (command.name === "CompleteMultipartUploadCommand") {
        completes += 1;
        // S3 completed the first call but the response was lost; the retry finds no upload.
        throw completes === 1 ? networkError() : statusError(404);
      }
      if (command.name === "HeadObjectCommand")
        return { ContentLength: 10, ETag: `"${etag}"`, VersionId: "v7" };
      if (command.name === "AbortMultipartUploadCommand") throw statusError(404);
      return {};
    });
    const result = await uploadBackup({
      file,
      config: backupS3Config(baseEnv),
      client,
      sdk,
      multipartThresholdBytes: 4,
      partSizeBytes: 4,
    });
    assert.equal(result.versionId, "v7");
    assert.equal(completes, 2);
    assert.equal(client.sent.at(-1)?.name, "AbortMultipartUploadCommand");

    // A 404 on the first completion attempt is a real failure, never "already written".
    const first404 = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u" };
      if (command.name === "UploadPartCommand") return { ETag: '"part"' };
      if (command.name === "CompleteMultipartUploadCommand") throw statusError(404);
      if (command.name === "HeadObjectCommand") throw new Error("must not be asked");
      return {};
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: first404,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      /http 404/,
    );

    // Lost response, but nothing was written: the original 404 stands.
    let tries = 0;
    const nothing = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u" };
      if (command.name === "UploadPartCommand") return { ETag: '"part"' };
      if (command.name === "CompleteMultipartUploadCommand") {
        tries += 1;
        throw tries === 1 ? networkError() : statusError(404);
      }
      if (command.name === "HeadObjectCommand") throw statusError(404);
      return {};
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: nothing,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      /http 404/,
    );
  });

  it("refuses a same-size object with different bytes, and a different size", async () => {
    const file = join(dir, "mismatch.dump");
    await writeFile(file, "PGDMP-data");
    for (const head of [
      { ContentLength: 10, ETag: `"${md5("OTHER-data")}"` },
      { ContentLength: 99, ETag: `"${md5("PGDMP-data")}"` },
    ]) {
      const client = conflictClient(
        () => head,
        () => Readable.from(["OTHER-data"]),
      );
      await assert.rejects(
        uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk }),
        /different object occupies/,
      );
      assert.equal(client.sent.length, head.ContentLength === 10 ? 3 : 2);
    }
  });

  it("streams SHA-256 comparison for unknown ETags and KMS, pinning the GET", async () => {
    const file = join(dir, "unknown-etag.dump");
    await writeFile(file, "PGDMP-data");
    for (const metadata of [
      { ETag: '"opaque"' },
      { ETag: `"${md5("provider-opaque-id")}"` },
      { ETag: `"${md5("ciphertext")}"`, ServerSideEncryption: "aws:kms" },
    ]) {
      for (const bytes of ["PGDMP-data", "OTHER-data"]) {
        const body = Readable.from([bytes]);
        const client = conflictClient(
          () => ({ ContentLength: 10, VersionId: "v2", ...metadata }),
          () => body,
        );
        const attempt = uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
        if (bytes === "PGDMP-data") assert.equal((await attempt).eTag, metadata.ETag);
        else await assert.rejects(attempt, /different object occupies/);
        assert.equal(client.sent.at(-1).input.IfMatch, metadata.ETag);
        assert.equal(client.sent.at(-1).input.VersionId, "v2");
        assert.equal(body.destroyed, true);
      }
    }
  });

  it("fails when HEAD cannot verify an existing object", async () => {
    const file = join(dir, "head-failure.dump");
    await writeFile(file, "PGDMP-data");
    const client = conflictClient(() => {
      throw new Error("HEAD unavailable");
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk }),
      /HEAD unavailable/,
    );
    assert.equal(client.sent.length, 2);
  });

  it("aborts a stuck upload at the total deadline and destroys its file stream", async () => {
    const file = join(dir, "stalled.dump");
    await writeFile(file, "PGDMP-data");
    let signal;
    let body;
    let calls = 0;
    const client = {
      send(command, options) {
        calls += 1;
        signal = options.abortSignal;
        body = command.input.Body;
        return new Promise(() => {}); // even a client ignoring abort cannot hold the caller
      },
    };
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk, deadlineMs: 30 }),
      /timed out/,
    );
    assert.equal(signal.aborted, true);
    assert.equal(body.destroyed, true);
    assert.equal(calls, 1, "deadline is not retried");
  });

  it("bounds metadata requests and a streaming download after headers arrive", async () => {
    const stalled = { send: () => new Promise(() => {}) };
    const location = { bucket: "backups", key: "stalled" };
    await assert.rejects(
      describeObject({
        location,
        config: backupS3Config(baseEnv),
        client: stalled,
        sdk,
        deadlineMs: 20,
      }),
      /timed out/,
    );
    const body = new Readable({
      read() {
        this.push("slow trickle");
        this._read = () => {};
      },
    });
    const client = fakeClient(() => ({ ETag: '"pinned"', Body: body }));
    await assert.rejects(
      downloadObject({
        location,
        dest: join(dir, "stalled-download"),
        eTag: '"pinned"',
        config: backupS3Config(baseEnv),
        client,
        sdk,
        deadlineMs: 30,
      }),
      /timed out/,
    );
    assert.equal(body.destroyed, true);
  });

  it("shares one deadline across retries and destroys every attempted stream", async () => {
    const file = join(dir, "retry-deadline.dump");
    await writeFile(file, "PGDMP-data");
    const bodies = [];
    const signals = [];
    const client = {
      async send(command, { abortSignal }) {
        bodies.push(command.input.Body);
        signals.push(abortSignal);
        if (bodies.length === 1) throw statusError(503);
        return new Promise((_, reject) =>
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
        );
      },
    };
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk, deadlineMs: 20 }),
      /timed out/,
    );
    assert.equal(bodies.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.ok(bodies.every((body) => body.destroyed));
  });

  it("applies the upload deadline to an existing object's verification download", async () => {
    const file = join(dir, "verification-deadline.dump");
    await writeFile(file, "PGDMP-data");
    const body = new Readable({ read() {} });
    const client = conflictClient(
      () => ({ ContentLength: 10, ETag: '"opaque"' }),
      () => body,
    );
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk, deadlineMs: 20 }),
      /timed out/,
    );
    assert.equal(body.destroyed, true);
  });

  it("relabels 400/405/501 only for the conditional write itself", async () => {
    const file = join(dir, "label.dump");
    await writeFile(file, "0123456789");
    const put = fakeClient(() => {
      throw statusError(400);
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: put, sdk }),
      /rejected PutObject with If-None-Match/,
    );
    // A part upload failing with 400 is not an If-None-Match problem.
    const part = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u3" };
      if (command.name === "UploadPartCommand") throw statusError(400);
      return {};
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: part,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      (error) => error instanceof Error && error.message === "http 400",
    );
    assert.equal(part.sent.at(-1)?.name, "AbortMultipartUploadCommand");
  });

  it("refuses a source outside the configured bucket", async () => {
    await assert.rejects(
      describeObject({
        location: { bucket: "other", key: "k" },
        config: backupS3Config(baseEnv),
        client: fakeClient(() => ({})),
        sdk,
      }),
      /not BACKUP_S3_BUCKET/,
    );
  });

  it("downloads with If-Match and rejects a changed object", async () => {
    const dest = join(dir, "download.dump");
    const client = fakeClient(() => ({ ETag: '"e1"', Body: Readable.from(["PGDMP"]) }));
    await downloadObject({
      location: { bucket: "backups", key: "k" },
      eTag: '"e1"',
      dest,
      config: backupS3Config(baseEnv),
      client,
      sdk,
    });
    assert.equal(await readFile(dest, "utf8"), "PGDMP");
    assert.equal(client.sent[0]?.input.IfMatch, '"e1"');

    const changed = fakeClient(() => ({ ETag: '"e2"', Body: Readable.from(["x"]) }));
    await assert.rejects(
      downloadObject({
        location: { bucket: "backups", key: "k" },
        eTag: '"e1"',
        dest,
        config: backupS3Config(baseEnv),
        client: changed,
        sdk,
      }),
      /changed/,
    );
  });

  it("compares ETags with or without quotes", () => {
    assert.equal(sameETag('"abc"', "abc"), true);
    assert.equal(sameETag('"abc"', '"abd"'), false);
    assert.equal(sameETag(null, "abc"), false);
  });
});

describe("loadS3Sdk", () => {
  it("turns a missing SDK into an actionable error", async () => {
    const missing = Object.assign(new Error("Cannot find package '@aws-sdk/client-s3'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await assert.rejects(
      loadS3Sdk(async () => {
        throw missing;
      }),
      /S3 backups need @aws-sdk\/client-s3, which is missing from this install.*unset BACKUP_S3_BUCKET/,
    );
  });

  it("passes other load failures through unchanged, including a missing SDK dependency", async () => {
    const broken = new Error("syntax error in the SDK");
    const dependency = Object.assign(
      new Error(
        "Cannot find package '@smithy/core' imported from /app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    for (const error of [broken, dependency]) {
      await assert.rejects(
        loadS3Sdk(async () => {
          throw error;
        }),
        (thrown) => thrown === error,
      );
    }
  });

  it("`s3.mjs check` refuses invalid BACKUP_S3_* settings before any dump", () => {
    const script = fileURLToPath(new URL("./s3.mjs", import.meta.url));
    const run = (env) =>
      spawnSync(process.execPath, [script, "check"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
    const missingKey = run({ BACKUP_S3_BUCKET: "b" });
    assert.equal(missingKey.status, 1);
    assert.match(missingKey.stderr, /ACCESS_KEY/);
    const badRegion = run({ ...baseEnv, BACKUP_S3_REGION: "" });
    assert.equal(badRegion.status, 1);
    assert.match(badRegion.stderr, /real AWS region/);
    assert.equal(run(baseEnv).status, 0);
    // The image build: no bucket, only the SDK.
    assert.equal(run({}).status, 0);
  });

  it("the S3 client's logger drops only the SDK's detail-free streaming warning", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    backupS3Logger.warn(SDK_STREAMING_RETRY_WARNING);
    backupS3Logger.warn("a different SDK warning");
    backupS3Logger.warn(SDK_STREAMING_RETRY_WARNING, "with detail");
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments),
      [["a different SDK warning"], [SDK_STREAMING_RETRY_WARNING, "with detail"]],
    );
    const client = await createS3Client(backupS3Config(baseEnv));
    t.after(() => client.destroy());
    assert.equal(client.config.logger, backupS3Logger);
    assert.equal(await client.config.maxAttempts(), 1);
  });

  it("loads the bundled SDK, and `s3.mjs check` succeeds", async () => {
    const sdk = await loadS3Sdk();
    assert.equal(typeof sdk.S3Client, "function");
    assert.equal(typeof sdk.PutObjectCommand, "function");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./s3.mjs", import.meta.url)), "check"],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...baseEnv } },
    );
    assert.equal(result.status, 0, result.stderr);
  });
});
