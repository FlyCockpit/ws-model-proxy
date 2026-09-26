import { describe, expect, it, vi } from "vitest";
import { createProtocolAdaptationTransform } from "./adaptation.js";
import {
  ADAPTER_VERSION,
  type CanonicalEvent,
  type CanonicalRequest,
  type CanonicalUsage,
  type ProtocolSurface,
} from "./canonical.js";
import { parseProtocolResponse } from "./nonstream.js";
import { CanonicalStreamParser } from "./streams.js";

const encode = (value: string) => new TextEncoder().encode(value);
const named = (type: string, data: Record<string, unknown>) =>
  encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

// Recorded field shapes from each vendor's documented usage object, all for the
// same reply: 104 input tokens processed (80 of them read from cache, 5 written
// to it) and 10 output tokens. OpenAI's input counts include cached tokens;
// Anthropic's `input_tokens` is only the 19 uncached ones.
const openAiChatUsage = {
  prompt_tokens: 104,
  completion_tokens: 10,
  total_tokens: 114,
  prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0 },
  completion_tokens_details: {
    reasoning_tokens: 4,
    audio_tokens: 0,
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 0,
  },
};

const openAiResponsesUsage = {
  input_tokens: 104,
  input_tokens_details: { cached_tokens: 80 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 4 },
  total_tokens: 114,
};

const anthropicUsage = {
  input_tokens: 19,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 80,
  cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
  output_tokens: 10,
  server_tool_use: { web_search_requests: 0 },
  service_tier: "standard",
};

/** Canonical input is every input token processed, whatever the source surface. */
const canonicalUsage = { inputTokens: 104, outputTokens: 10 };

const usageBySurface = {
  "openai-chat": openAiChatUsage,
  "openai-responses": openAiResponsesUsage,
  "anthropic-messages": anthropicUsage,
} satisfies Record<ProtocolSurface, Record<string, unknown>>;

const responsesEnvelope = (status: "in_progress" | "completed", usage: unknown) => ({
  id: "r",
  object: "response",
  created_at: 0,
  status,
  error: null,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: null,
  model: "gpt",
  output: [],
  parallel_tool_calls: false,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: false,
  temperature: null,
  text: { format: { type: "text" } },
  tool_choice: "none",
  tools: [],
  top_p: null,
  truncation: "disabled",
  metadata: {},
  usage,
});

function nonstreamUsage(surface: ProtocolSurface, usage: unknown): CanonicalUsage | undefined {
  const body =
    surface === "openai-chat"
      ? {
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "gpt",
          service_tier: "default",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok", refusal: null, annotations: [] },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage,
        }
      : surface === "openai-responses"
        ? {
            id: "r",
            object: "response",
            status: "completed",
            output: [
              {
                id: "i",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage,
          }
        : {
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          };
  const parsed = parseProtocolResponse({ surface, status: 200, body });
  if (!parsed.ok) throw new Error("expected success");
  return parsed.response.usage;
}

const anthropicStart = (usage: unknown) =>
  named("message_start", {
    message: {
      id: "m",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude",
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
const anthropicDelta = (usage: unknown) =>
  named("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage });

function streamUsage(surface: ProtocolSurface, usage: unknown): CanonicalUsage | undefined {
  const parser = new CanonicalStreamParser(surface);
  const chunks =
    surface === "openai-chat"
      ? [
          encode(
            `data: ${JSON.stringify({
              id: "c",
              object: "chat.completion.chunk",
              created: 0,
              model: "gpt",
              choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
              usage,
            })}\n\n`,
          ),
          encode("data: [DONE]\n\n"),
        ]
      : surface === "openai-responses"
        ? [
            named("response.created", {
              sequence_number: 0,
              response: responsesEnvelope("in_progress", null),
            }),
            named("response.completed", {
              sequence_number: 1,
              response: responsesEnvelope("completed", usage),
            }),
          ]
        : [anthropicStart(usage), anthropicDelta({ output_tokens: 10 }), named("message_stop", {})];
  const events = [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()];
  if (surface === "anthropic-messages") {
    const start = events.find((event) => event.type === "message_start");
    return start?.type === "message_start" ? start.usage : undefined;
  }
  const usageEvents = events.filter((event) => event.type === "usage");
  expect(usageEvents).toHaveLength(1);
  const [only] = usageEvents;
  return only?.type === "usage" ? only.usage : undefined;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("shared stream and non-stream usage parser", () => {
  it.each(Object.keys(usageBySurface) as ProtocolSurface[])(
    "accepts the real %s usage shape on both paths with the same counts",
    (surface) => {
      const usage = usageBySurface[surface];
      expect(nonstreamUsage(surface, usage)).toEqual(canonicalUsage);
      expect(streamUsage(surface, usage)).toEqual(canonicalUsage);
    },
  );

  it.each(Object.keys(usageBySurface) as ProtocolSurface[])(
    "ignores unknown usage and detail keys for %s",
    (surface) => {
      const base: Record<string, unknown> = usageBySurface[surface];
      const detailKey = Object.keys(base).find(
        (key) => typeof base[key] === "object" && base[key] !== null,
      );
      if (!detailKey) throw new Error("fixture needs a detail object");
      const usage = {
        ...base,
        vendor_usage: { anything: "goes" },
        [detailKey]: { ...(base[detailKey] as Record<string, unknown>), future_tokens: "n/a" },
      };
      expect(nonstreamUsage(surface, usage)).toEqual(canonicalUsage);
      expect(streamUsage(surface, usage)).toEqual(canonicalUsage);
    },
  );

  it("treats null detail objects and null Anthropic cache counts as absent", () => {
    expect(
      nonstreamUsage("openai-chat", {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(
      streamUsage("anthropic-messages", {
        input_tokens: 1,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 0 });
    expect(
      nonstreamUsage("anthropic-messages", {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 7,
      }),
    ).toEqual({ inputTokens: 8, outputTokens: 2 });
  });

  it.each([
    ["openai-chat", { ...openAiChatUsage, prompt_tokens: "19" }, "usage.prompt_tokens"],
    ["openai-chat", { ...openAiChatUsage, total_tokens: -1 }, "usage.total_tokens"],
    ["openai-responses", { ...openAiResponsesUsage, total_tokens: "114" }, "usage.total_tokens"],
    [
      "openai-chat",
      {
        ...openAiChatUsage,
        completion_tokens_details: {
          ...openAiChatUsage.completion_tokens_details,
          reasoning_tokens: -1,
        },
      },
      "usage.completion_tokens_details.reasoning_tokens",
    ],
    [
      "openai-chat",
      { ...openAiChatUsage, prompt_tokens_details: "cached" },
      "usage.prompt_tokens_details",
    ],
    [
      "openai-responses",
      { ...openAiResponsesUsage, input_tokens_details: { cached_tokens: 1.5 } },
      "usage.input_tokens_details.cached_tokens",
    ],
    [
      "anthropic-messages",
      { ...anthropicUsage, cache_read_input_tokens: "80" },
      "usage.cache_read_input_tokens",
    ],
    [
      "anthropic-messages",
      {
        ...anthropicUsage,
        cache_creation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: 0 },
      },
      "usage.cache_creation.ephemeral_5m_input_tokens",
    ],
    ["anthropic-messages", { ...anthropicUsage, output_tokens: null }, "usage.output_tokens"],
  ] as const)("rejects a malformed known %s count on both paths", (surface, usage, parameter) => {
    expect(thrown(() => nonstreamUsage(surface, usage))).toMatchObject({
      code: "invalid_usage",
      parameter,
    });
    expect(thrown(() => streamUsage(surface, usage))).toMatchObject({
      code: "invalid_usage",
      parameter: parameter.replace(/^usage/u, "stream.usage"),
    });
  });

  it("uses each surface's fixed count names", () => {
    expect(() =>
      nonstreamUsage("openai-chat", { input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ).toThrow(/missing required token counts/u);
    expect(() =>
      nonstreamUsage("anthropic-messages", { prompt_tokens: 1, completion_tokens: 1 }),
    ).toThrow(/missing required token counts/u);
  });
});

function anthropicStreamEvents(chunks: Uint8Array[]): CanonicalEvent[] {
  const parser = new CanonicalStreamParser("anthropic-messages");
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()];
}

function usageEvents(events: CanonicalEvent[]): CanonicalUsage[] {
  return events.flatMap((event) => (event.type === "usage" ? [event.usage] : []));
}

const pingRequest: CanonicalRequest = {
  adapterVersion: ADAPTER_VERSION,
  source: "anthropic-messages",
  model: "claude",
  instructions: [],
  messages: [
    { role: "user", content: [{ type: "text", text: "ping" }], boundary: { sourceIndex: 0 } },
  ],
  tools: [],
  parallelToolCalls: "single",
  stream: true,
  sampling: {},
  limitations: [],
};

async function adapt(
  source: ProtocolSurface,
  target: ProtocolSurface,
  chunks: Uint8Array[],
  onProtocolError = vi.fn(),
) {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).pipeThrough(
    createProtocolAdaptationTransform({
      source,
      target,
      recoverProtocolErrors: true,
      onProtocolError,
      // The Anthropic renderer estimates message_start input from the request.
      request: pingRequest,
    }),
  );
  return { output: await new Response(readable).text(), onProtocolError };
}

const renderedUsage = (
  target: "openai-chat" | "openai-responses",
  input: number,
  output: number,
) =>
  target === "openai-chat"
    ? `"usage":{"prompt_tokens":${input},"completion_tokens":${output},"total_tokens":${input + output}}`
    : `"usage":{"input_tokens":${input},"output_tokens":${output},"total_tokens":${input + output}}`;

describe("Anthropic message_delta usage", () => {
  const start = anthropicStart({ ...anthropicUsage, output_tokens: 1 });

  it.each([
    [
      "the modern shape restating every count",
      {
        input_tokens: 19,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 80,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
        output_tokens: 10,
        server_tool_use: { web_search_requests: 1 },
        service_tier: "standard",
      },
      canonicalUsage,
    ],
    [
      "input with null cache counts",
      {
        input_tokens: 19,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: 10,
        server_tool_use: null,
      },
      canonicalUsage,
    ],
    [
      "a later cache count with null input",
      { input_tokens: null, cache_read_input_tokens: 90, output_tokens: 10 },
      { inputTokens: 114, outputTokens: 10 },
    ],
    ["output only", { output_tokens: 10 }, { outputTokens: 10 }],
  ] as const)("keeps canonical input inclusive for %s", (_name, deltaUsage, expected) => {
    const events = anthropicStreamEvents([
      start,
      anthropicDelta(deltaUsage),
      named("message_stop", {}),
    ]);
    expect(events.find((event) => event.type === "message_start")).toMatchObject({
      usage: { inputTokens: 104, outputTokens: 1 },
    });
    expect(usageEvents(events)).toEqual([expected]);
  });

  it.each([
    [{ output_tokens: 10, cache_read_input_tokens: "80" }, "stream.usage.cache_read_input_tokens"],
    [
      { output_tokens: 10, cache_creation_input_tokens: -1 },
      "stream.usage.cache_creation_input_tokens",
    ],
    [{ input_tokens: 1.5, output_tokens: 10 }, "stream.usage.input_tokens"],
    [{ output_tokens: null }, "stream.usage.output_tokens"],
    [
      { output_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: "0" } },
      "stream.usage.cache_creation.ephemeral_1h_input_tokens",
    ],
  ] as const)("rejects a malformed known count %#", (deltaUsage, parameter) => {
    const parser = new CanonicalStreamParser("anthropic-messages");
    parser.push(start);
    expect(thrown(() => parser.push(anthropicDelta(deltaUsage)))).toMatchObject({
      code: "invalid_usage",
      parameter,
    });
  });

  it.each(["openai-chat", "openai-responses"] as const)(
    "renders inclusive input through the cumulative merge into %s",
    async (target) => {
      for (const deltaUsage of [
        { output_tokens: 10 },
        {
          input_tokens: 19,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens: 10,
        },
        { ...anthropicUsage, output_tokens: 10 },
      ]) {
        const { output, onProtocolError } = await adapt("anthropic-messages", target, [
          start,
          anthropicDelta(deltaUsage),
          named("message_stop", {}),
        ]);
        expect(onProtocolError).not.toHaveBeenCalled();
        expect(output).toContain(renderedUsage(target, 104, 10));
        expect(output).not.toContain(
          target === "openai-chat" ? 'prompt_tokens":19' : 'input_tokens":19',
        );
      }
    },
  );

  it("renders inclusive input for a non-stream Anthropic reply", () => {
    const parsed = parseProtocolResponse({
      surface: "anthropic-messages",
      status: 200,
      body: {
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: anthropicUsage,
      },
    });
    if (!parsed.ok) throw new Error("expected success");
    expect(parsed.response.usage).toEqual(canonicalUsage);
  });
});

describe("total_tokens is validated but not reconciled", () => {
  // Some OpenAI-compatible servers count reasoning in total_tokens only.
  const mismatched = {
    "openai-chat": { ...openAiChatUsage, total_tokens: 130 },
    "openai-responses": { ...openAiResponsesUsage, total_tokens: 130 },
  } as const;

  it.each(["openai-chat", "openai-responses"] as const)(
    "accepts a mismatched %s total on both paths",
    (surface) => {
      expect(nonstreamUsage(surface, mismatched[surface])).toEqual(canonicalUsage);
      expect(streamUsage(surface, mismatched[surface])).toEqual(canonicalUsage);
    },
  );

  const chatChunk = (value: Record<string, unknown>) =>
    encode(
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        ...value,
      })}\n\n`,
    );

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "completes a Chat stream into %s when the mismatched total arrives after output",
    async (target) => {
      const { output, onProtocolError } = await adapt("openai-chat", target, [
        chatChunk({
          choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
        }),
        chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chatChunk({ choices: [], usage: mismatched["openai-chat"] }),
        encode("data: [DONE]\n\n"),
      ]);
      expect(onProtocolError).not.toHaveBeenCalled();
      expect(output).not.toContain("event: error");
      expect(output).toContain(
        target === "openai-responses"
          ? renderedUsage(target, 104, 10)
          : '"usage":{"input_tokens":104,"output_tokens":10}',
      );
    },
  );
});
