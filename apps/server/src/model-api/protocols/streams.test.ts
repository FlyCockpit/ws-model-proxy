import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./canonical.js";
import {
  CanonicalStreamParser,
  CanonicalStreamRenderer,
  createCanonicalSseTransform,
} from "./streams.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const event = (name: string, data: Record<string, unknown>) =>
  bytes(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);

describe("strict canonical stream parsing", () => {
  it.each([
    ["openai-chat", "openai-chat-sse.json"],
    ["openai-responses", "openai-responses-sse.json"],
    ["anthropic-messages", "anthropic-messages-sse.json"],
  ] as const)("conforms to the pinned published-derived %s lifecycle", async (surface, file) => {
    const fixture = JSON.parse(
      await readFile(new URL(`./fixtures/published/${file}`, import.meta.url), "utf8"),
    ) as {
      events: Array<{ event?: string; data: string | Record<string, unknown> }>;
    };
    const parser = new CanonicalStreamParser(surface);
    const canonical = fixture.events.flatMap((wire) => {
      const data = typeof wire.data === "string" ? wire.data : JSON.stringify(wire.data);
      return parser.push(bytes(`${wire.event ? `event: ${wire.event}\n` : ""}data: ${data}\n\n`));
    });
    parser.finish();
    expect(canonical[0]?.type).toBe("message_start");
    expect(canonical.at(-1)?.type).toBe("complete");
  });

  it("commits retry on every emitted event, including message_start", () => {
    const parser = new CanonicalStreamParser("openai-responses");
    expect(parser.retrySafe).toBe(true);
    expect(parser.push(event("response.created", { response: { id: "r" } }))).toEqual([
      { type: "message_start", id: "r" },
    ]);
    expect(parser.retrySafe).toBe(false);
  });

  it.each([
    ["unknown SSE field", bytes('wat: x\ndata: {"choices":[]}\n\n')],
    ["unknown Chat field", bytes('data: {"id":"x","choices":[],"secret":1}\n\n')],
    ["unknown Responses event", event("response.magic", {})],
    ["mismatched event names", bytes('event: message_stop\ndata: {"type":"ping"}\n\n')],
  ])("rejects %s", (_name, input) => {
    const surface =
      _name.includes("Chat") || _name.includes("SSE")
        ? "openai-chat"
        : _name.includes("mismatched")
          ? "anthropic-messages"
          : "openai-responses";
    expect(() => new CanonicalStreamParser(surface).push(input)).toThrow();
  });

  it("bounds each unfinished event rather than the aggregate drained chunk", () => {
    const parser = new CanonicalStreamParser("openai-chat", { maxEventBytes: 128 });
    const small = 'data: {"id":"x","choices":[]}\n\n';
    expect(parser.push(bytes(small.repeat(20)))).toHaveLength(1);
    expect(parser.retrySafe).toBe(false);
  });

  it("rejects malformed UTF-8 instead of replacing invalid bytes", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    expect(() => parser.push(new Uint8Array([0xc3, 0x28]))).toThrow("UTF-8");
  });

  it("enforces indexes, item lifecycle, complete tool JSON, and exactly one terminal", () => {
    const invalidIndex = new CanonicalStreamParser("anthropic-messages");
    invalidIndex.push(event("message_start", { message: { id: "m" } }));
    expect(() =>
      invalidIndex.push(
        event("content_block_start", { index: -1, content_block: { type: "text", text: "" } }),
      ),
    ).toThrow("non-negative");

    const tool = new CanonicalStreamParser("anthropic-messages");
    tool.push(event("message_start", { message: { id: "m" } }));
    tool.push(
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "c", name: "lookup", input: {} },
      }),
    );
    tool.push(
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":' },
      }),
    );
    expect(() => tool.push(event("content_block_stop", { index: 0 }))).toThrow(
      "complete JSON object",
    );

    const duplicate = new CanonicalStreamParser("openai-chat");
    duplicate.push(
      bytes('data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'),
    );
    duplicate.push(bytes("data: [DONE]\n\n"));
    expect(() => duplicate.push(bytes("data: [DONE]\n\n"))).toThrow("terminal");
  });

  it("bounds unfinished items and checks cancellation during push and finish", () => {
    const parser = new CanonicalStreamParser("anthropic-messages", { maxUnfinishedItems: 1 });
    parser.push(event("message_start", { message: { id: "m" } }));
    parser.push(
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    );
    expect(() =>
      parser.push(
        event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      ),
    ).toThrow("unfinished");

    const controller = new AbortController();
    const cancelled = new CanonicalStreamParser("openai-chat", { signal: controller.signal });
    controller.abort();
    expect(() => cancelled.push(new Uint8Array())).toThrow("cancelled");
    expect(() => cancelled.finish()).toThrow("cancelled");
  });
});

describe("protocol-conformant stateful rendering", () => {
  const canonical: CanonicalEvent[] = [
    { type: "message_start", id: "m", model: "model" },
    { type: "item_start", index: 0, id: "text", itemType: "text" },
    { type: "text_delta", index: 0, delta: "hello" },
    { type: "item_complete", index: 0 },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
    { type: "stop", reason: "stop" },
    { type: "complete" },
  ];

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "renders and reparses a complete %s lifecycle",
    (surface) => {
      const renderer = new CanonicalStreamRenderer(surface);
      const output = canonical.flatMap((item) => renderer.push(item));
      renderer.finish();
      const parser = new CanonicalStreamParser(surface);
      const parsed = output.flatMap((chunk) => parser.push(chunk));
      parser.finish();
      expect(parsed.some((item) => item.type === "text_delta")).toBe(true);
      expect(parsed.filter((item) => item.type === "complete")).toHaveLength(1);
    },
  );

  it("rejects invalid canonical order and cancellation", () => {
    expect(() => new CanonicalStreamRenderer("openai-chat").push({ type: "complete" })).toThrow(
      "before",
    );
    const controller = new AbortController();
    const renderer = new CanonicalStreamRenderer("openai-chat", { signal: controller.signal });
    controller.abort();
    expect(() => renderer.push({ type: "message_start", id: "m" })).toThrow("cancelled");
  });

  it("renders Responses length stops as incomplete and preserves usage", () => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const rendered = [
      ...renderer.push({ type: "message_start", id: "r", model: "gpt" }),
      ...renderer.push({ type: "usage", usage: { inputTokens: 4, outputTokens: 8 } }),
      ...renderer.push({ type: "stop", reason: "length" }),
      ...renderer.push({ type: "complete" }),
    ].map((chunk) => new TextDecoder().decode(chunk));
    renderer.finish();
    expect(rendered.join("\n")).toContain("event: response.incomplete");
    expect(rendered.join("\n")).toContain('"reason":"max_output_tokens"');
    expect(rendered.join("\n")).toContain('"input_tokens":4');
  });

  it("preserves structured stream error metadata and requested envelopes", () => {
    const parser = new CanonicalStreamParser("anthropic-messages", {
      upstreamStatus: 429,
      requestId: "req_header",
      retryAfter: "5",
    });
    const events = parser.push(
      event("error", {
        request_id: "req_event",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
    );
    expect(events).toEqual([
      {
        type: "error",
        error: {
          code: "rate_limit_error",
          message: "slow down",
          upstreamStatus: 429,
          requestId: "req_event",
          retryAfter: "5",
        },
      },
    ]);
    expect(parser.retrySafe).toBe(false);
    expect(() => parser.push(event("error", { error: { message: "again" } }))).toThrow("terminal");
  });

  it("exposes a bounded, backpressure-aware TransformStream", async () => {
    const transform = createCanonicalSseTransform("openai-chat", { highWaterMarkBytes: 128 });
    const reader = transform.readable.getReader();
    const writer = transform.writable.getWriter();
    const read = reader.read();
    await writer.write({ type: "message_start", id: "m" });
    expect((await read).value?.byteLength).toBeGreaterThan(0);
    await writer.write({ type: "stop", reason: "stop" });
    await reader.read();
    await writer.write({ type: "complete" });
    await reader.read();
    await writer.close();
    expect(() => createCanonicalSseTransform("openai-chat", { highWaterMarkBytes: 0 })).toThrow();

    const bounded = createCanonicalSseTransform("openai-chat", { maxChunkBytes: 8 });
    await expect(
      bounded.writable.getWriter().write({ type: "message_start", id: "too-large" }),
    ).rejects.toThrow("bounded buffer");
  });
});
