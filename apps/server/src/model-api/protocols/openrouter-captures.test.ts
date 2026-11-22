/**
 * Real OpenRouter replies (2026-11-22, `fixtures/openrouter-live/2026-11-22-*.raw`) adapted
 * to every other client surface. Reasoning models (deepseek-v4.1-flash on Chat, gpt-6-luna on
 * Responses) carry `reasoning`, `reasoning_details`, reasoning output items and a message
 * `phase`; Claude Haiku 5.5 on Messages carries `caller` on tool use and empty `citations` on
 * text. None of that is answer content: every reply adapts, keeping its text, tool call and
 * usage.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalRequest, ProtocolSurface } from "./canonical.js";
import { adaptNonstreamResponse, createProtocolAdaptationTransform } from "./index.js";

const live = (name: string) =>
  readFileSync(new URL(`../fixtures/openrouter-live/2026-11-22-${name}.raw`, import.meta.url));

const SURFACES: ProtocolSurface[] = ["openai-chat", "openai-responses", "anthropic-messages"];

/** A Chat client's request; `streamUsage` is its `stream_options.include_usage`. */
function request(stream: boolean, streamUsage: boolean | "absent" = true): CanonicalRequest {
  return {
    adapterVersion: "1.0.0" as CanonicalRequest["adapterVersion"],
    source: "openai-chat",
    model: "m",
    instructions: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "ping" }], boundary: { sourceIndex: 0 } },
    ],
    tools: [],
    parallelToolCalls: "single",
    stream,
    ...(streamUsage !== "absent" ? { streamUsage } : {}),
    sampling: {},
    limitations: [],
  };
}

async function adaptStream(
  source: ProtocolSurface,
  target: ProtocolSurface,
  body: Uint8Array,
  streamUsage: boolean | "absent" = true,
) {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }).pipeThrough(
    createProtocolAdaptationTransform({ source, target, request: request(true, streamUsage) }),
  );
  return new Response(readable).text();
}

/** The visible answer of a rendered reply, whatever its surface. */
/** A JSON record of a rendered reply, read through these narrow accessors. */
type Wire = { [key: string]: unknown };
const rec = (value: unknown): Wire =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : {};
const list = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(rec) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function answerOf(surface: ProtocolSurface, rendered: string): { text: string; tools: string[] } {
  const records = rendered.trimStart().startsWith("{")
    ? [rec(JSON.parse(rendered))]
    : rendered
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => rec(JSON.parse(line.slice(6))));
  let out = "";
  const tools: string[] = [];
  for (const record of records) {
    if (surface === "openai-chat") {
      for (const choice of list(record.choices)) {
        const part = rec(choice.message ?? choice.delta);
        out += text(part.content);
        for (const call of list(part.tool_calls)) {
          const name = text(rec(call.function).name);
          if (name) tools.push(name);
        }
      }
    } else if (surface === "openai-responses") {
      if (record.type === "response.output_text.delta") out += text(record.delta);
      if (record.object === "response")
        for (const item of list(record.output)) {
          if (item.type === "message")
            for (const content of list(item.content)) out += text(content.text);
          if (item.type === "function_call") tools.push(text(item.name));
        }
      if (record.type === "response.output_item.added") {
        const item = rec(record.item);
        if (item.type === "function_call") tools.push(text(item.name));
      }
    } else {
      if (record.type === "message")
        for (const block of list(record.content)) {
          if (block.type === "text") out += text(block.text);
          if (block.type === "tool_use") tools.push(text(block.name));
        }
      if (record.type === "content_block_delta") {
        const delta = rec(record.delta);
        if (delta.type === "text_delta") out += text(delta.text);
      }
      if (record.type === "content_block_start") {
        const block = rec(record.content_block);
        if (block.type === "tool_use") tools.push(text(block.name));
      }
    }
  }
  return { text: out, tools };
}

const CAPTURES: Array<{
  name: string;
  source: ProtocolSurface;
  stream: boolean;
  text: string | RegExp;
  tool?: string;
}> = [
  { name: "reasoning-chat-nonstream", source: "openai-chat", stream: false, text: "pong" },
  { name: "reasoning-chat-stream", source: "openai-chat", stream: true, text: /1.*5/su },
  {
    name: "reasoning-chat-tool-nonstream",
    source: "openai-chat",
    stream: false,
    text: /check/u,
    tool: "get_weather",
  },
  {
    name: "reasoning-chat-tool-stream",
    source: "openai-chat",
    stream: true,
    text: /check/u,
    tool: "get_weather",
  },
  {
    name: "reasoning-responses-nonstream",
    source: "openai-responses",
    stream: false,
    text: "pong",
  },
  {
    name: "reasoning-responses-stream",
    source: "openai-responses",
    stream: true,
    text: "1, 2, 3, 4, 5",
  },
  {
    name: "claude-messages-nonstream",
    source: "anthropic-messages",
    stream: false,
    text: /pong/iu,
  },
  { name: "claude-messages-stream", source: "anthropic-messages", stream: true, text: /\w/u },
  {
    name: "claude-messages-tool-nonstream",
    source: "anthropic-messages",
    stream: false,
    text: "",
    tool: "get_weather",
  },
  {
    name: "claude-messages-tool-stream",
    source: "anthropic-messages",
    stream: true,
    text: "",
    tool: "get_weather",
  },
];

describe("real OpenRouter replies adapt to every other surface", () => {
  for (const capture of CAPTURES)
    for (const target of SURFACES.filter((surface) => surface !== capture.source))
      it(`${capture.name} → ${target}`, async () => {
        const body = live(capture.name);
        const rendered = capture.stream
          ? await adaptStream(capture.source, target, body)
          : JSON.stringify(
              (() => {
                const adapted = adaptNonstreamResponse({
                  source: capture.source,
                  target,
                  body: JSON.parse(body.toString("utf8")),
                  status: 200,
                });
                if (!adapted.ok) throw new Error("expected a successful adaptation");
                return adapted.body;
              })(),
            );
        expect(rendered).not.toMatch(/protocol_error|violated the adapted protocol/u);
        const answer = answerOf(target, rendered);
        if (typeof capture.text === "string") expect(answer.text).toBe(capture.text);
        else expect(answer.text).toMatch(capture.text);
        expect(answer.tools).toEqual(capture.tool ? [capture.tool] : []);
        // Reasoning never leaks into an adapted answer.
        expect(rendered).not.toMatch(/reasoning_details|encrypted_content/u);
        // Usage reaches every surface.
        expect(rendered).toMatch(
          target === "openai-chat" ? /"prompt_tokens":\d+/u : /"input_tokens":\d+/u,
        );
      });

  it("an adapted Chat stream names a tool call once and ends finish, usage, [DONE] (as OpenAI)", async () => {
    const output = await adaptStream(
      "anthropic-messages",
      "openai-chat",
      live("claude-messages-tool-stream"),
    );
    const records = output
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    const chunks = records
      .filter((record) => record !== "[DONE]")
      .map((record) => rec(JSON.parse(record)));
    const calls = chunks.flatMap((chunk) =>
      list(chunk.choices).flatMap((choice) => list(rec(choice.delta).tool_calls)),
    );
    expect(calls.length).toBeGreaterThan(1);
    // id, type and name only in the first chunk of the call (clients concatenate strings).
    expect(calls.filter((call) => call.id !== undefined)).toHaveLength(1);
    expect(calls.filter((call) => rec(call.function).name !== undefined)).toHaveLength(1);
    expect(calls.slice(1).every((call) => Object.keys(call).join() === "index,function")).toBe(
      true,
    );
    const arguments_ = calls.map((call) => text(rec(call.function).arguments)).join("");
    expect(JSON.parse(arguments_)).toEqual({ city: "Paris" });
    const tail = chunks.slice(-2);
    expect(list(tail[0]?.choices)[0]?.finish_reason).toBe("tool_calls");
    expect(tail[1]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 386, completion_tokens: 50 },
    });
    expect(records.at(-1)).toBe("[DONE]");
  });

  it("an adapted Chat stream sends its usage chunk only when the client asked for it", async () => {
    const body = live("claude-messages-stream");
    expect(await adaptStream("anthropic-messages", "openai-chat", body, true)).toMatch(/"usage"/u);
    // Asked for none, or did not ask (no `stream_options`, or `{}`): no usage chunk, as OpenAI.
    for (const asked of [false, "absent"] as const)
      expect(await adaptStream("anthropic-messages", "openai-chat", body, asked)).not.toMatch(
        /"usage"/u,
      );
  });

  describe("dropped reasoning items stay consistent", () => {
    const records = () =>
      live("reasoning-responses-stream")
        .toString("utf8")
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => rec(JSON.parse(line.slice(6))));
    const sse = (events: Wire[]) =>
      new TextEncoder().encode(
        events
          .map(
            (event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
          )
          .join(""),
      );
    const reasoningDone = (event: Wire) =>
      event.type === "response.output_item.done" && rec(event.item).type === "reasoning";
    it("a reasoning item that never completes is a protocol error", async () => {
      await expect(
        adaptStream(
          "openai-responses",
          "openai-chat",
          sse(records().filter((event) => !reasoningDone(event))),
        ),
      ).rejects.toThrow(/reasoning items/u);
    });
    it("a reasoning event naming another item is a protocol error", async () => {
      const events = records();
      const added = events.findIndex(
        (event) =>
          event.type === "response.output_item.added" && rec(event.item).type === "reasoning",
      );
      const injected = [
        ...events.slice(0, added + 1),
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          summary_index: 0,
          item_id: "rs_other",
          delta: "thinking",
        },
        ...events.slice(added + 1),
      ];
      await expect(adaptStream("openai-responses", "openai-chat", sse(injected))).rejects.toThrow(
        /changed IDs/u,
      );
      // The same event naming its own item is dropped, and the reply adapts.
      const ownId = rec(events[added]?.item).id;
      const own = injected.map((event) =>
        event.item_id === "rs_other" ? { ...event, item_id: ownId } : event,
      );
      await expect(adaptStream("openai-responses", "openai-chat", sse(own))).resolves.toMatch(
        /1, 2, 3, 4, 5|\[DONE\]/u,
      );
    });

    it("a reasoning item done or repeated as unfinished is a protocol error", async () => {
      const doneUnfinished = records().map((event) =>
        reasoningDone(event)
          ? { ...event, item: { ...rec(event.item), status: "in_progress" } }
          : event,
      );
      await expect(
        adaptStream("openai-responses", "openai-chat", sse(doneUnfinished)),
      ).rejects.toThrow(/must be completed/u);
      const terminalUnfinished = records().map((event) => {
        if (event.type !== "response.completed") return event;
        const response = rec(event.response);
        const [first, ...rest] = list(response.output);
        return {
          ...event,
          response: { ...response, output: [{ ...first, status: "in_progress" }, ...rest] },
        };
      });
      await expect(
        adaptStream("openai-responses", "openai-chat", sse(terminalUnfinished)),
      ).rejects.toThrow(/reasoning items/u);
    });

    it("a terminal that changes a reasoning item's id is a protocol error", async () => {
      const events = records().map((event) => {
        if (event.type !== "response.completed") return event;
        const response = rec(event.response);
        const [first, ...rest] = list(response.output);
        return {
          ...event,
          response: { ...response, output: [{ ...first, id: "rs_other" }, ...rest] },
        };
      });
      await expect(adaptStream("openai-responses", "openai-chat", sse(events))).rejects.toThrow(
        /reasoning items/u,
      );
    });
  });
});
