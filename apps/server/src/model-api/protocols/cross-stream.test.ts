import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./canonical.js";
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
  it("pins an independent literal golden for the complete empty Responses wire", () => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const actual = [
      ...renderer.push({ type: "message_start", id: "r", model: "gpt" }),
      ...renderer.push({ type: "stop", reason: "stop" }),
      ...renderer.push({ type: "complete" }),
    ].map((chunk) => new TextDecoder().decode(chunk));
    renderer.finish();
    expect(actual).toEqual([
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","created_at":0,"status":"in_progress","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt","output":[],"parallel_tool_calls":false,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"none","tools":[],"top_p":null,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"id":"r","object":"response","created_at":0,"status":"completed","error":null,"model":"gpt","output":[],"incomplete_details":null,"instructions":null,"max_output_tokens":null,"parallel_tool_calls":false,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"none","tools":[],"top_p":null,"truncation":"disabled","metadata":{},"usage":null}}\n\n',
    ]);
  });

  it("incrementally closes Chat through Responses before source DONE", async () => {
    const canonical = await chatFixtureEvents();
    const renderer = new CanonicalStreamRenderer("openai-responses", {
      maxAggregateBytes: 64,
    });
    const parser = new CanonicalStreamParser("openai-responses", { maxAggregateBytes: 64 });
    let observedTextBeforeComplete = false;
    const reparsed: CanonicalEvent[] = [];
    for (const event of canonical) {
      for (const chunk of renderer.push(event)) reparsed.push(...parser.push(chunk));
      if (event.type !== "complete" && reparsed.some((item) => item.type === "text_delta"))
        observedTextBeforeComplete = true;
    }
    renderer.finish();
    reparsed.push(...parser.finish());
    expect(observedTextBeforeComplete).toBe(true);
    expect(reparsed.at(-1)).toEqual({ type: "complete" });
  });

  it("rejects Chat to Anthropic streaming because initial usage is unavailable", async () => {
    const start = (await chatFixtureEvents())[0];
    expect(start).toMatchObject({ type: "message_start" });
    expect(() => new CanonicalStreamRenderer("anthropic-messages").push(start!)).toThrow(
      "initial usage",
    );
  });

  it.each([
    {
      name: "empty text",
      events: [
        { type: "item_start", index: 0, id: "empty", itemType: "text" },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
    {
      name: "refusal",
      events: [
        { type: "item_start", index: 0, id: "refusal", itemType: "refusal" },
        { type: "refusal_delta", index: 0, delta: "no" },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
    {
      name: "tool",
      events: [
        { type: "item_start", index: 0, id: "call", itemType: "tool_call" },
        {
          type: "tool_arguments_delta",
          index: 0,
          id: "call",
          name: "lookup",
          delta: "{}",
        },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
  ])("incrementally closes $name through Responses", ({ name, events }) => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const parser = new CanonicalStreamParser("openai-responses");
    const canonical: CanonicalEvent[] = [
      { type: "message_start", id: "m", model: "model" },
      ...events,
      { type: "stop", reason: name === "tool" ? "tool" : "stop" },
      { type: "complete" },
    ];
    const reparsed = canonical.flatMap((event) =>
      renderer.push(event).flatMap((chunk) => parser.push(chunk)),
    );
    renderer.finish();
    reparsed.push(...parser.finish());
    expect(reparsed.filter((event) => event.type === "item_complete")).toHaveLength(1);
    expect(reparsed.at(-1)).toEqual({ type: "complete" });
  });

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
