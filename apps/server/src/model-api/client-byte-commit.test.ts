import { describe, expect, it, vi } from "vitest";
import { responseWithFirstClientByte } from "./client-byte-commit.js";

describe("responseWithFirstClientByte", () => {
  it("marks exactly once at the first rendered non-empty byte, not at headers", async () => {
    const mark = vi.fn(async () => undefined);
    const response = responseWithFirstClientByte(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array());
            controller.enqueue(new TextEncoder().encode("first"));
            controller.enqueue(new TextEncoder().encode("second"));
            controller.close();
          },
        }),
        { status: 202, headers: { "x-request-id": "upstream" } },
      ),
      mark,
    );

    expect(mark).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBe("upstream");
    expect(await response.text()).toBe("firstsecond");
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it("does not mark an empty response and propagates cancellation upstream", async () => {
    const mark = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const empty = responseWithFirstClientByte(new Response(null, { status: 204 }), mark);
    expect((await empty.arrayBuffer()).byteLength).toBe(0);

    const streamed = responseWithFirstClientByte(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => undefined);
          },
          cancel,
        }),
      ),
      mark,
    );
    await streamed.body?.cancel("client gone");
    expect(cancel).toHaveBeenCalledWith("client gone");
    expect(mark).not.toHaveBeenCalled();
  });
});
