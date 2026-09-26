import { describe, expect, it } from "vitest";
import type { CanonicalUsage, ProtocolSurface } from "./canonical.js";
import { parseProtocolResponse } from "./nonstream.js";
import { CanonicalStreamParser } from "./streams.js";

const encode = (value: string) => new TextEncoder().encode(value);
const named = (type: string, data: Record<string, unknown>) =>
  encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

// Recorded field shapes from each vendor's documented usage object.
const openAiChatUsage = {
  prompt_tokens: 19,
  completion_tokens: 10,
  total_tokens: 29,
  prompt_tokens_details: { cached_tokens: 3, audio_tokens: 0 },
  completion_tokens_details: {
    reasoning_tokens: 4,
    audio_tokens: 0,
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 0,
  },
};

const openAiResponsesUsage = {
  input_tokens: 19,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 4 },
  total_tokens: 29,
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
        : [
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
            }),
            named("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 10 },
            }),
            named("message_stop", {}),
          ];
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
      expect(nonstreamUsage(surface, usage)).toEqual({ inputTokens: 19, outputTokens: 10 });
      expect(streamUsage(surface, usage)).toEqual({ inputTokens: 19, outputTokens: 10 });
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
      expect(nonstreamUsage(surface, usage)).toEqual({ inputTokens: 19, outputTokens: 10 });
      expect(streamUsage(surface, usage)).toEqual({ inputTokens: 19, outputTokens: 10 });
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
  });

  it.each([
    ["openai-chat", { ...openAiChatUsage, prompt_tokens: "19" }, "usage.prompt_tokens"],
    ["openai-chat", { ...openAiChatUsage, total_tokens: 30 }, "usage.total_tokens"],
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
