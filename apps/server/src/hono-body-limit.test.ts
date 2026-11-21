import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describe, expect, it, vi } from "vitest";

function streamedPost(body: ReadableStream<Uint8Array>, headers?: RequestInit["headers"]): Request {
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, headers, duplex: "half" };
  return new Request("http://localhost/", init);
}

describe("Hono body-limit security upgrade", () => {
  it("preserves a body delivered in single-byte and empty chunks at the limit", async () => {
    const payload = new TextEncoder().encode("tiny chunks: café");
    const app = new Hono();
    app.use(bodyLimit({ maxSize: payload.length }));
    app.post("/", async (c) => c.body(await c.req.arrayBuffer()));

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of payload) {
          controller.enqueue(new Uint8Array(0));
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    });
    const response = await app.request(streamedPost(body));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it("rejects a fragmented body one byte over the limit before the handler runs", async () => {
    const handler = vi.fn((c: Context) => c.text("accepted"));
    const app = new Hono();
    app.use(bodyLimit({ maxSize: 4 }));
    app.post("/", handler);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(Uint8Array.of(97));
        controller.close();
      },
    });
    const response = await app.request(
      streamedPost(body, { "content-length": "1", "transfer-encoding": "chunked" }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
    expect(handler).not.toHaveBeenCalled();
  });
});
