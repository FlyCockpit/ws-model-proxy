import { lstat } from "node:fs/promises";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 1024,
    MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 4096,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 5_000,
    MODEL_API_TRANSCRIPTION_SPOOL_DIR: "/tmp/wsmp-multipart-adversarial-tests",
  },
}));

const { MultipartIngressError, parseMultipartToSpool } = await import("./multipart-form-data.js");
const disposables: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((item) => item.dispose()));
});

function rawRequest(boundary: string, body: string | Uint8Array) {
  return new Request("https://proxy.test/v1/audio/transcriptions", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: "half",
  } as RequestInit);
}

function multipartBody(boundary: string, value: string | Uint8Array, filename?: string) {
  const disposition = filename
    ? `Content-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream`
    : 'Content-Disposition: form-data; name="model"';
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n`),
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe("multipart ingress adversarial matrix", () => {
  it.each([
    ["missing closing boundary", '--x\r\nContent-Disposition: form-data; name="model"\r\n\r\nm'],
    ["malformed header", "--x\r\nnot-a-header\r\n\r\nx\r\n--x--\r\n"],
    ["bare line endings", '--x\nContent-Disposition: form-data; name="model"\n\nm\n--x--\n'],
  ])("rejects %s", async (_name, body) => {
    await expect(
      parseMultipartToSpool(rawRequest("x", body), "multipart/form-data; boundary=x"),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a file over the configured streaming limit", async () => {
    const form = new FormData();
    form.set("model", "m");
    form.set("file", new File([new Uint8Array(1025)], "voice.wav", { type: "audio/wav" }));
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    await expect(
      parseMultipartToSpool(request, request.headers.get("content-type")!),
    ).rejects.toMatchObject({ code: "request_too_large" } satisfies Partial<
      InstanceType<typeof MultipartIngressError>
    >);
  });

  it("accepts a file exactly at the configured streaming limit", async () => {
    const form = new FormData();
    form.set("model", "m");
    form.set("file", new File([new Uint8Array(1024)], "voice.wav"));
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const parsed = await parseMultipartToSpool(request, request.headers.get("content-type")!);
    disposables.push(parsed);
    expect(parsed.parts.find((part) => part.kind === "file")?.size).toBe(1024);
  });

  it("accepts a quoted boundary parameter", async () => {
    const body = multipartBody("quoted-boundary", "m");
    const contentType = 'multipart/form-data; boundary="quoted-boundary"';
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    const parsed = await parseMultipartToSpool(request, contentType);
    disposables.push(parsed);
    expect(parsed.parts).toContainEqual({ kind: "field", name: "model", value: "m" });
  });

  it("preserves boundary-like bytes inside a file", async () => {
    const bytes = Buffer.from("before\r\n--almost-a-boundary\r\nafter\0\xff", "latin1");
    const body = multipartBody("actual-boundary", bytes, "voice.bin");
    const parsed = await parseMultipartToSpool(
      rawRequest("actual-boundary", body),
      "multipart/form-data; boundary=actual-boundary",
    );
    disposables.push(parsed);
    const file = parsed.parts.find((part) => part.kind === "file");
    expect(file).toMatchObject({ kind: "file", size: bytes.byteLength });
  });

  it("preserves Unicode scalar values", async () => {
    const form = new FormData();
    form.set("model", "m");
    form.set("prompt", "Zażółć gęślą jaźń — こんにちは");
    form.set("file", new File([new Uint8Array([1])], "voice.wav"));
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const parsed = await parseMultipartToSpool(request, request.headers.get("content-type")!);
    disposables.push(parsed);
    expect(parsed.parts).toContainEqual({
      kind: "field",
      name: "prompt",
      value: "Zażółć gęślą jaźń — こんにちは",
    });
  });

  it("does not relay injected multipart headers and rejects oversized headers", async () => {
    const injection =
      '--x\r\nContent-Disposition: form-data; name="file"; filename="ok\r\nX-Evil: yes"\r\n\r\nx\r\n--x--\r\n';
    const injected = await parseMultipartToSpool(
      rawRequest("x", injection),
      "multipart/form-data; boundary=x",
    );
    disposables.push(injected);
    const rebuiltChunks: Uint8Array[] = [];
    for await (const chunk of injected.build("m").body.open()) rebuiltChunks.push(chunk);
    expect(Buffer.concat(rebuiltChunks).toString("latin1")).not.toContain("X-Evil");

    const oversized = `--x\r\nContent-Disposition: form-data; name="model"\r\nX-Fill: ${"a".repeat(17 * 1024)}\r\n\r\nm\r\n--x--\r\n`;
    await expect(
      parseMultipartToSpool(rawRequest("x", oversized), "multipart/form-data; boundary=x"),
    ).rejects.toBeInstanceOf(Error);
  });

  it("accepts the exact raw multipart limit and rejects one byte over it", async () => {
    const shell = multipartBody("x", "");
    const exact = multipartBody("x", "a".repeat(4096 - shell.byteLength));
    expect(exact.byteLength).toBe(4096);
    const parsed = await parseMultipartToSpool(
      rawRequest("x", exact),
      "multipart/form-data; boundary=x",
    );
    disposables.push(parsed);
    const over = Buffer.concat([exact, Buffer.from("x")]);
    await expect(
      parseMultipartToSpool(rawRequest("x", over), "multipart/form-data; boundary=x"),
    ).rejects.toMatchObject({ code: "request_too_large" });
  });

  it("cancels an incomplete upload when the request is aborted", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n'),
        );
      },
    });
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const parsing = parseMultipartToSpool(request, "multipart/form-data; boundary=x");
    controller.abort(new Error("client disconnected"));
    await expect(parsing).rejects.toThrow("client disconnected");
  });

  it("cancels ingress immediately and releases spool resources after a disk write failure", async () => {
    let sourceCancelled = false;
    let writes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (writes++ === 0) {
          controller.enqueue(
            Buffer.from(
              '--x\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\n\r\naudio',
            ),
          );
        }
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
    const diskError = new Error("injected ENOSPC");
    const failingOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(diskError);
      },
    });
    let uploadDirectory = "";

    await expect(
      parseMultipartToSpool(request, "multipart/form-data; boundary=x", {
        createSpoolWriteStream: () => failingOutput,
        onSpoolDirectoryCreated: (path) => {
          uploadDirectory = path;
        },
      }),
    ).rejects.toThrow("injected ENOSPC");
    expect(sourceCancelled).toBe(true);

    // Cleanup and quota release are observable: no upload directory remains,
    // and a subsequent upload can acquire and use the same singleton budget.
    expect(uploadDirectory).not.toBe("");
    await expect(lstat(uploadDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const recovery = new FormData();
    recovery.set("model", "m");
    recovery.set("file", new File([new Uint8Array([1])], "voice.wav"));
    const recoveryRequest = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: recovery,
    });
    const parsed = await parseMultipartToSpool(
      recoveryRequest,
      recoveryRequest.headers.get("content-type")!,
    );
    disposables.push(parsed);
  });

  it("preserves binary bytes and vendor fields while safely rewriting model", async () => {
    const bytes = new Uint8Array([0, 13, 10, 255, 1, 2, 0]);
    const form = new FormData();
    form.append("vendor_option", "keep-me");
    form.append("model", "public/model");
    form.append("file", new File([bytes], "../voice.wav", { type: "audio/wav" }));
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const parsed = await parseMultipartToSpool(request, request.headers.get("content-type")!);
    disposables.push(parsed);
    const built = parsed.build("upstream/model");
    const chunks: Uint8Array[] = [];
    for await (const chunk of built.body.open()) chunks.push(chunk);
    const output = Buffer.concat(chunks);
    expect(output.includes(Buffer.from(bytes))).toBe(true);
    expect(output.toString("latin1")).toContain("keep-me");
    expect(output.toString("latin1")).toContain("upstream/model");
    expect(output.toString("latin1")).not.toContain("public/model");
  });

  it("preserves parser-normalized filename paths and safely re-quotes them", async () => {
    const form = new FormData();
    form.append("model", "public/model");
    form.append("file", new File(["audio"], 'folder\\voice"one.wav'));
    const request = new Request("https://proxy.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const parsed = await parseMultipartToSpool(request, request.headers.get("content-type")!);
    disposables.push(parsed);
    const file = parsed.parts.find((part) => part.kind === "file");
    // Undici's FormData serializer percent-encodes a quote. Busboy deliberately
    // does not percent-decode Content-Disposition parameters; WMP preserves the
    // parser value instead of applying a lossy second normalization.
    expect(file?.filename).toBe("folder\\voice%22one.wav");
    const rebuilt = parsed.build("upstream/model");
    const chunks: Uint8Array[] = [];
    for await (const chunk of rebuilt.body.open()) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("latin1")).toContain(
      'filename="folder\\\\voice%22one.wav"',
    );
  });
});
