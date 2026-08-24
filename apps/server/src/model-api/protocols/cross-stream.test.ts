import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, ProtocolSurface } from "./canonical.js";
import { CanonicalStreamParser, CanonicalStreamRenderer } from "./streams.js";

const encode = (value: string) => new TextEncoder().encode(value);

async function chatFixtureEvents(): Promise<CanonicalEvent[]> {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/generated-conformance/openai-chat-sse.json", import.meta.url),
      "utf8",
    ),
  ) as { events: Array<{ data: unknown }> };
  const parser = new CanonicalStreamParser("openai-chat");
  const events = fixture.events.flatMap(({ data }) =>
    parser.push(encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)),
  );
  events.push(...parser.finish());
  return events;
}

describe("cross-protocol streaming conformance", () => {
  it.each(["openai-responses", "anthropic-messages"] as const)(
    "renders the official-derived Chat fixture through %s without full-output buffering",
    async (surface: ProtocolSurface) => {
      const canonical = await chatFixtureEvents();
      expect(canonical.some((event) => event.type === "item_complete")).toBe(true);
      const renderer = new CanonicalStreamRenderer(surface, { maxAggregateBytes: 64 });
      const parser = new CanonicalStreamParser(surface, { maxAggregateBytes: 64 });
      const reparsed = canonical.flatMap((event) =>
        renderer.push(event).flatMap((chunk) => parser.push(chunk)),
      );
      renderer.finish();
      reparsed.push(...parser.finish());
      expect(reparsed.some((event) => event.type === "text_delta")).toBe(true);
      expect(reparsed.at(-1)).toEqual({ type: "complete" });
    },
  );

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "rejects an error after stop for %s",
    (surface) => {
      const renderer = new CanonicalStreamRenderer(surface);
      renderer.push({
        type: "message_start",
        id: "m",
        model: "model",
        ...(surface === "anthropic-messages" ? { usage: { inputTokens: 0, outputTokens: 0 } } : {}),
      });
      renderer.push({ type: "stop", reason: "stop" });
      expect(() =>
        renderer.push({ type: "error", error: { code: "bad", message: "bad" } }),
      ).toThrow("stop barrier");
    },
  );

  it.each([
    {},
    { inputTokens: 1 },
    { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ])("rejects incomplete or unsafe canonical usage %#", (usage) => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    renderer.push({ type: "message_start", id: "m", model: "model" });
    expect(() => renderer.push({ type: "usage", usage })).toThrow("safe integer");
  });
});
