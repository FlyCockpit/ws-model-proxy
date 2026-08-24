import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import Busboy from "@fastify/busboy";
import { env } from "@ws-model-proxy/env/server";
import type { RelayBodySource } from "./request-body-source.js";

const MAX_FIELDS = 64;
const MAX_PARTS = 66;
const MAX_FIELD_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export type MultipartScalarPart = { kind: "field"; name: string; value: string };
export type MultipartFilePart = {
  kind: "file";
  name: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
};
export type MultipartPart = MultipartScalarPart | MultipartFilePart;
export type ReplayableMultipart = {
  parts: MultipartPart[];
  build(upstreamModelId: string): { contentType: string; body: RelayBodySource };
  dispose(): Promise<void>;
};

type MultipartSpoolDependencies = {
  /** Test seam for deterministic disk failures; production always uses fs.createWriteStream. */
  createSpoolWriteStream?: (path: string) => Writable;
  onSpoolDirectoryCreated?: (path: string) => void;
};

export class MultipartIngressError extends Error {
  constructor(
    readonly code: "invalid_multipart" | "request_too_large" | "rate_limited" | "timeout",
  ) {
    super(code);
    this.name = "MultipartIngressError";
  }
}

class SpoolBudget {
  private active = 0;
  private bytes = 0;
  acquire() {
    if (this.active >= env.MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS)
      throw new MultipartIngressError("rate_limited");
    this.active += 1;
    let reserved = 0;
    let released = false;
    return {
      reserve: (count: number) => {
        if (this.bytes + count > env.MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES)
          throw new MultipartIngressError("request_too_large");
        this.bytes += count;
        reserved += count;
      },
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.bytes -= reserved;
      },
    };
  }
}

const spoolBudget = new SpoolBudget();
let initialized: Promise<string> | undefined;
async function spoolRoot() {
  initialized ??= (async () => {
    const baseRoot = resolve(
      env.MODEL_API_TRANSCRIPTION_SPOOL_DIR ?? join(tmpdir(), "wsmp-transcription"),
    );
    await mkdir(baseRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(baseRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("The transcription spool root must be a real directory.");
    }
    await chmod(baseRoot, 0o700);
    // Do not sweep sibling instance directories: age cannot prove another
    // process is dead (it may be paused), so startup cleanup could delete a
    // live upload. Operators may remove orphaned instance-* directories only
    // after establishing that no WSMP process uses this base directory.
    const root = await mkdtemp(join(baseRoot, "instance-"));
    await chmod(root, 0o700);
    return root;
  })();
  return initialized;
}

function quoted(value: string) {
  if (/\r|\n/.test(value)) throw new MultipartIngressError("invalid_multipart");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function multipartSource(parts: MultipartPart[], upstreamModelId: string) {
  const boundary = `----wsmp-${crypto.randomUUID()}`;
  // Validation guarantees exactly one model part. Replace it in place so
  // provider extensions that attach meaning to multipart order keep working.
  const relayParts = parts.map(
    (part): MultipartPart =>
      part.name === "model" ? { kind: "field", name: "model", value: upstreamModelId } : part,
  );
  const prefixFor = (part: MultipartPart) => {
    if (part.kind === "field") {
      return encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(part.name)}\r\n\r\n${part.value}\r\n`,
      );
    }
    return encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(part.name)}; filename=${quoted(part.filename)}\r\nContent-Type: ${part.mimeType || "application/octet-stream"}\r\n\r\n`,
    );
  };
  const suffix = encoder.encode(`--${boundary}--\r\n`);
  const encodedParts = relayParts.map((part) => ({ part, prefix: prefixFor(part) }));
  const size =
    encodedParts.reduce(
      (sum, { part, prefix }) =>
        sum + prefix.byteLength + (part.kind === "file" ? part.size + 2 : 0),
      0,
    ) + suffix.byteLength;
  const body: RelayBodySource = {
    kind: "spool",
    // RelaySessionManager treats this as an exact framing invariant, not merely
    // a payload metric, so include boundaries, headers, scalar bytes and CRLFs.
    size,
    async *open() {
      for (const { part, prefix } of encodedParts) {
        yield prefix;
        if (part.kind === "file") {
          for await (const chunk of createReadStream(part.path)) yield new Uint8Array(chunk);
          yield encoder.encode("\r\n");
        }
      }
      yield suffix;
    },
    async dispose() {},
  };
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

export async function parseMultipartToSpool(
  request: Request,
  contentType: string,
  dependencies: MultipartSpoolDependencies = {},
): Promise<ReplayableMultipart> {
  if (!request.body) throw new MultipartIngressError("invalid_multipart");
  const budget = spoolBudget.acquire();
  let directory: string | undefined;
  const parts: MultipartPart[] = [];
  let rawMultipartBytes = 0;
  let failure: unknown;
  const writes: Promise<void>[] = [];
  const outputs: Writable[] = [];
  const abort = new AbortController();
  const timeout = setTimeout(
    () => abort.abort(new MultipartIngressError("timeout")),
    env.MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS,
  );
  const onRequestAbort = () => abort.abort(request.signal.reason);
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  const withAbort = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = () =>
        rejectPromise(
          abort.signal.reason instanceof Error
            ? abort.signal.reason
            : new MultipartIngressError("invalid_multipart"),
        );
      if (abort.signal.aborted) return onAbort();
      abort.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          abort.signal.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        (error: unknown) => {
          abort.signal.removeEventListener("abort", onAbort);
          rejectPromise(error);
        },
      );
    });
  try {
    const root = await spoolRoot();
    const uploadDirectory = await mkdtemp(join(root, "upload-"));
    directory = uploadDirectory;
    dependencies.onSpoolDirectoryCreated?.(uploadDirectory);
    await chmod(uploadDirectory, 0o700);
    const fsInfo = await statfs(root);
    if (Number(fsInfo.bavail) * Number(fsInfo.bsize) < env.MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES)
      throw new MultipartIngressError("rate_limited");
    const parser = Busboy({
      headers: { "content-type": contentType },
      // The decoded filename is opaque protocol data and is never used as a
      // filesystem path (spool paths are generated below). `preservePath`
      // retains path separators. Rebuilding preserves that decoded value,
      // escaping only quoted-string backslashes and quotes; CR/LF are rejected.
      preservePath: true,
      limits: {
        fieldNameSize: 256,
        fieldSize: MAX_FIELD_BYTES,
        fields: MAX_FIELDS,
        fileSize: env.MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES,
        files: 2,
        parts: MAX_PARTS,
        headerPairs: 64,
        headerSize: 16 * 1024,
      },
    });
    const exceeded = (code: MultipartIngressError["code"] = "invalid_multipart") => {
      failure ??= new MultipartIngressError(code);
    };
    parser.on("partsLimit", () => exceeded());
    parser.on("filesLimit", () => exceeded());
    parser.on("fieldsLimit", () => exceeded());
    parser.on("field", (name, value, nameTruncated, valueTruncated) => {
      if (nameTruncated || valueTruncated || /\r|\n/.test(name)) return exceeded();
      const count = Buffer.byteLength(value);
      try {
        budget.reserve(count);
      } catch (error) {
        failure ??= error;
        parser.destroy(error as Error);
      }
      parts.push({ kind: "field", name, value });
    });
    let fileIndex = 0;
    parser.on("file", (name, stream, filename, _encoding, mimeType) => {
      const path = join(uploadDirectory, `part-${fileIndex++}`);
      const part: MultipartFilePart = {
        kind: "file",
        name,
        filename,
        mimeType,
        path,
        size: 0,
      };
      if (
        Buffer.byteLength(filename) > 512 ||
        /\r|\n/.test(name) ||
        /\r|\n/.test(filename) ||
        /\r|\n/.test(mimeType)
      )
        exceeded();
      const output =
        dependencies.createSpoolWriteStream?.(path) ??
        createWriteStream(path, { flags: "wx", mode: 0o600 });
      outputs.push(output);
      // A filesystem failure must stop ingress immediately. Merely retaining
      // the rejection from finished(output) can leave the parser waiting for
      // the rest of a large (or stalled) request before it surfaces the error.
      output.once("error", (error) => {
        failure ??= error;
        stream.unpipe(output);
        stream.resume();
        parser.destroy(error);
        abort.abort(error);
      });
      stream.on("limit", () => exceeded("request_too_large"));
      stream.on("data", (chunk: Buffer) => {
        try {
          part.size += chunk.byteLength;
          budget.reserve(chunk.byteLength);
        } catch (error) {
          failure ??= error;
          parser.destroy(error as Error);
        }
      });
      stream.pipe(output);
      parts.push(part);
      writes.push(finished(output));
    });
    const parserDone = new Promise<void>((resolvePromise, rejectPromise) => {
      parser.once("error", rejectPromise);
      parser.once("finish", resolvePromise);
    });
    // The abort path may reject this before control reaches an await below.
    // Register a rejection observer immediately while retaining the original
    // promise for normal control flow.
    void parserDone.catch(() => undefined);
    const reader = request.body.getReader();
    const cancelReader = () => {
      void reader.cancel(abort.signal.reason);
    };
    abort.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read());
        if (done) break;
        rawMultipartBytes += value.byteLength;
        if (rawMultipartBytes > env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES)
          throw new MultipartIngressError("request_too_large");
        const accepted = parser.write(value);
        if (failure) {
          // A limit event can fire synchronously from write(). Do not wait for
          // `finish` before ending/destroying the parser: a truncated file may
          // have applied backpressure and would otherwise deadlock until the
          // upload timeout.
          void parserDone.catch(() => undefined);
          parser.destroy(failure instanceof Error ? failure : undefined);
          throw failure;
        }
        if (!accepted) await withAbort(Promise.race([once(parser, "drain"), parserDone]));
      }
      parser.end();
      await withAbort(parserDone);
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      abort.signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
    await Promise.all(writes);
    if (failure) throw failure;
    // Busboy may ignore a syntactically invalid first part and still emit
    // finish. An empty multipart request is never useful to an audio endpoint,
    // so reject it at the parser boundary instead of treating it as valid.
    if (parts.length === 0) throw new MultipartIngressError("invalid_multipart");
    let disposed = false;
    return {
      parts,
      build(upstreamModelId) {
        if (disposed) throw new Error("Multipart spool has been disposed.");
        return multipartSource(parts, upstreamModelId);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        budget.release();
        await rm(uploadDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Observe write-stream failures before leaving the function. Otherwise a
    // filesystem error can become an unhandled rejection while cleanup races.
    for (const output of outputs) {
      if (!output.destroyed) output.destroy(error instanceof Error ? error : undefined);
    }
    await Promise.allSettled(writes);
    budget.release();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onRequestAbort);
  }
}
