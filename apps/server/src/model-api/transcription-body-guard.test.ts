import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { transcriptionContentLengthGuard } from "./transcription-body-guard.js";

describe("transcription content-length guard", () => {
  it("does not consume a chunked body before the route reads it incrementally", async () => {
    const app = new Hono();
    const observed: number[] = [];
    app.use("/upload", transcriptionContentLengthGuard({ maxMultipartBytes: 4, maxFileBytes: 3 }));
    app.post("/upload", async (c) => {
      const reader = c.req.raw.body?.getReader();
      if (!reader) throw new Error("expected body");
      observed.push((await reader.read()).value?.[0] ?? -1);
      observed.push((await reader.read()).value?.[0] ?? -1);
      return c.text("ok");
    });
    let pull = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        controller.enqueue(new Uint8Array([pull]));
        if (pull === 2) controller.close();
      },
    });

    const response = await app.request(
      new Request("http://test/upload", { method: "POST", body: source, duplex: "half" }),
    );
    expect(response.status).toBe(200);
    expect(observed).toEqual([1, 2]);
  });

  it("returns 413 from content-length without pulling the body", async () => {
    const app = new Hono();
    const pull = vi.fn();
    app.use("/upload", transcriptionContentLengthGuard({ maxMultipartBytes: 4, maxFileBytes: 3 }));
    app.post("/upload", (c) => c.text("unexpected"));
    const request = new Request("http://test/upload", {
      method: "POST",
      headers: { "content-length": "5" },
      body: new ReadableStream<Uint8Array>({ pull }),
      duplex: "half",
    });
    await Promise.resolve();
    const pullsBeforeDispatch = pull.mock.calls.length;
    const response = await app.request(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "request_too_large",
        message:
          "Transcription upload is too large: this server accepts requests up to 4 bytes with an audio file up to 3 bytes. Split or compress the audio and send each part separately.",
      },
    });
    expect(pull).toHaveBeenCalledTimes(pullsBeforeDispatch);
  });
});
