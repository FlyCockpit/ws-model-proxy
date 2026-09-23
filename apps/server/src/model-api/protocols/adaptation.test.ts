import { describe, expect, it } from "vitest";
import {
  adaptNonstreamResponse,
  createProtocolAdaptationTransform,
  estimateInputTokens,
  parseCanonicalRequest,
  renderCanonicalRequest,
} from "./adaptation.js";
import { ADAPTER_VERSION, type CanonicalRequest } from "./canonical.js";
import { CanonicalStreamParser } from "./streams.js";

const vendorMessage = {
  annotations: null,
  audio: null,
  content: "pong",
  function_call: null,
  reasoning: "hidden",
  refusal: null,
  role: "assistant",
};

const vendorChoice = {
  index: 0,
  message: vendorMessage,
  finish_reason: "stop" as const,
  logprobs: null,
  stop_reason: 154827,
  token_ids: null,
  routed_experts: null,
};

const vendorChatCompletion = {
  id: "c",
  object: "chat.completion",
  created: 0,
  model: "gpt",
  choices: [vendorChoice],
  usage: {
    prompt_tokens: 19,
    completion_tokens: 32,
    total_tokens: 51,
    prompt_tokens_details: null,
  },
  prompt_logprobs: null,
  prompt_token_ids: null,
  prompt_text: null,
  kv_transfer_params: null,
  ec_transfer_params: null,
  metrics: null,
};

describe("protocol adaptation orchestration", () => {
  it("parses once and renders the requested model without mutating canonical state", () => {
    const canonical = parseCanonicalRequest("openai-chat", {
      model: "pool",
      messages: [{ role: "user", content: "hello" }],
    });
    const before = structuredClone(canonical);
    expect(
      renderCanonicalRequest({ request: canonical, target: "openai-responses", model: "up" }),
    ).toMatchObject({ model: "up", input: [{ role: "user" }] });
    expect(canonical).toEqual(before);
  });

  it("renders nonstream responses into the requested envelope", () => {
    const result = adaptNonstreamResponse({
      source: "openai-chat",
      target: "openai-responses",
      status: 200,
      body: {
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "gpt",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toMatchObject({ object: "response", status: "completed" });
  });

  it("adapts a Chat Completions body that carries ignorable vendor fields", () => {
    for (const target of ["openai-responses", "anthropic-messages"] as const) {
      const result = adaptNonstreamResponse({
        source: "openai-chat",
        target,
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, reasoning_content: "REASONING_CONTENT_HIDDEN" },
            },
          ],
        },
      });
      expect(result.ok, target).toBe(true);
      if (result.ok) {
        expect(JSON.stringify(result.body)).toContain("pong");
        expect(JSON.stringify(result.body)).not.toContain("hidden");
        expect(JSON.stringify(result.body)).not.toContain("REASONING_CONTENT_HIDDEN");
      }
    }
  });

  it("accepts prompt token details only in the cached-token shape", () => {
    const withDetails = (prompt_tokens_details: unknown) =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          usage: { ...vendorChatCompletion.usage, prompt_tokens_details },
        },
      });
    expect(withDetails({ cached_tokens: 4 }).ok).toBe(true);
    expect(() => withDetails({ cached_tokens: 4, audio_tokens: 0 })).toThrow(/audio_tokens/u);
  });

  it("rejects a non-null chat envelope or choice field outside the ignorable null set", () => {
    for (const field of [
      "prompt_logprobs",
      "prompt_token_ids",
      "prompt_text",
      "kv_transfer_params",
      "ec_transfer_params",
      "metrics",
    ]) {
      expect(() =>
        adaptNonstreamResponse({
          source: "openai-chat",
          target: "openai-responses",
          status: 200,
          body: { ...vendorChatCompletion, [field]: [{ token: "x" }] },
        }),
      ).toThrow(new RegExp(field, "u"));
    }
    for (const field of ["token_ids", "routed_experts"]) {
      expect(() =>
        adaptNonstreamResponse({
          source: "openai-chat",
          target: "anthropic-messages",
          status: 200,
          body: {
            ...vendorChatCompletion,
            choices: [{ ...vendorChoice, [field]: [1, 2] }],
          },
        }),
      ).toThrow(new RegExp(field, "u"));
    }
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [{ ...vendorChoice, logprobs: { content: [] } }],
        },
      }),
    ).toThrow(/logprobs/u);
  });

  it("still rejects a present non-null Chat Completions field outside the ignorable set", () => {
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, audio: { id: "clip" } },
            },
          ],
        },
      }),
    ).toThrow(/audio/u);
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, extra_vendor_field: true },
            },
          ],
        },
      }),
    ).toThrow(/extra_vendor_field/u);
  });

  it("rejects reasoning text when it is the only visible answer", () => {
    const onlyReasoning = (message: Record<string, unknown>) =>
      expect(() =>
        adaptNonstreamResponse({
          source: "openai-chat",
          target: "anthropic-messages",
          status: 200,
          body: {
            ...vendorChatCompletion,
            choices: [{ ...vendorChoice, message }],
          },
        }),
      ).toThrow(/only visible text/u);
    onlyReasoning({ ...vendorMessage, content: null });
    onlyReasoning({
      ...vendorMessage,
      content: null,
      reasoning: null,
      reasoning_content: "REASONING_CONTENT_HIDDEN",
    });
    onlyReasoning({
      ...vendorMessage,
      content: null,
      reasoning: "hidden",
      reasoning_content: "REASONING_CONTENT_HIDDEN",
    });
  });

  it("drops stream reasoning deltas when later content holds the answer", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const encode = (value: unknown) =>
      new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      encode({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const events = [
      ...parser.push(
        encode({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt",
          prompt_logprobs: null,
          prompt_token_ids: null,
          prompt_text: null,
          kv_transfer_params: null,
          ec_transfer_params: null,
          metrics: null,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                reasoning: "hidden",
                reasoning_content: "REASONING_CONTENT_HIDDEN",
                audio: null,
                annotations: null,
              },
              finish_reason: null,
              stop_reason: 154827,
              token_ids: null,
              routed_experts: null,
            },
          ],
        }),
      ),
      ...parser.push(chunk({ content: "pong" })),
      ...parser.push(
        encode({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 32,
            total_tokens: 51,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ),
      ...parser.push(new TextEncoder().encode("data: [DONE]\n\n")),
    ];
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      expect.objectContaining({ delta: "pong" }),
    ]);
    expect(events.some((event) => event.type === "reasoning_delta")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("hidden");
    expect(JSON.stringify(events)).not.toContain("REASONING_CONTENT_HIDDEN");
  });

  it("rejects a chat stream whose only text is reasoning", () => {
    const encode = (value: unknown) =>
      new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const onlyReasoning = (delta: Record<string, unknown>) => {
      const parser = new CanonicalStreamParser("openai-chat");
      parser.push(
        encode({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt",
          choices: [{ index: 0, delta, finish_reason: null }],
        }),
      );
      parser.push(
        encode({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      expect(() => parser.push(new TextEncoder().encode("data: [DONE]\n\n"))).toThrow(
        /only visible text/u,
      );
    };
    onlyReasoning({ reasoning: "hidden" });
    onlyReasoning({ reasoning_content: "REASONING_CONTENT_HIDDEN" });
    onlyReasoning({ reasoning: "hidden", reasoning_content: "REASONING_CONTENT_HIDDEN" });
  });

  it("streams through the bounded parser and renderer state machines", async () => {
    const transform = createProtocolAdaptationTransform({
      source: "openai-chat",
      target: "openai-responses",
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const chunks: string[] = [];
    const consume = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        chunks.push(new TextDecoder().decode(result.value));
      }
    })();
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      ),
    );
    expect(chunks.join("")).toContain("response.created");
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    await writer.close();
    await consume;
    expect(chunks.join("")).toContain("response.completed");
  });
});

function estimatedRequest(input: {
  instructions?: string[];
  texts?: string[];
  images?: boolean;
  toolCalls?: Array<{ name: string; arguments: string }>;
  toolResults?: string[];
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  toolChoiceName?: string;
}): CanonicalRequest {
  return {
    adapterVersion: ADAPTER_VERSION,
    source: "anthropic-messages",
    model: "ignored-model",
    instructions: (input.instructions ?? []).map((text, sourceIndex) => ({
      role: "system",
      content: [{ type: "text", text }],
      boundary: { sourceIndex },
    })),
    messages: [
      {
        role: "user",
        boundary: { sourceIndex: 0 },
        content: [
          ...(input.texts ?? []).map((text) => ({ type: "text" as const, text })),
          ...(input.images
            ? [
                {
                  type: "image" as const,
                  source: { kind: "url" as const, url: "https://example.test/huge.png" },
                },
              ]
            : []),
          ...(input.toolCalls ?? []).map((call, index) => ({
            type: "tool_call" as const,
            id: `call-${index}`,
            name: call.name,
            arguments: call.arguments,
          })),
          ...(input.toolResults ?? []).map((text) => ({
            type: "tool_result" as const,
            toolCallId: "call-0",
            content: [{ type: "text" as const, text }],
          })),
        ],
      },
    ],
    tools: input.tools ?? [],
    ...(input.toolChoiceName
      ? { toolChoice: { type: "tool" as const, name: input.toolChoiceName } }
      : {}),
    parallelToolCalls: "single",
    stream: true,
    sampling: { temperature: 0.7, maxOutputTokens: 32 },
    limitations: [],
  };
}

describe("estimateInputTokens", () => {
  it("counts ping as 1, empty input as 0, and includes a tool name plus schema", () => {
    expect(estimateInputTokens(estimatedRequest({ texts: ["ping"] }))).toBe(1);
    expect(estimateInputTokens(estimatedRequest({}))).toBe(0);
    const schema = { type: "object" };
    const withTool = estimatedRequest({
      texts: ["ping"],
      tools: [{ name: "lookup", inputSchema: schema }],
    });
    const encoded = new TextEncoder().encode(["ping", "lookup", JSON.stringify(schema)].join("\n"));
    expect(estimateInputTokens(withTool)).toBe(Math.ceil(encoded.byteLength / 4));
    expect(estimateInputTokens(withTool)).toBeGreaterThan(1);
  });

  it("includes instructions, tool calls, tool results, descriptions, and tool choice, not images", () => {
    const described = { type: "object", properties: { q: { type: "string" } } };
    const request = estimatedRequest({
      instructions: ["be brief"],
      texts: ["ping"],
      images: true,
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      toolResults: ["ok"],
      tools: [{ name: "lookup", description: "find", inputSchema: described }],
      toolChoiceName: "lookup",
    });
    const parts = [
      "be brief",
      "ping",
      "lookup",
      "{}",
      "ok",
      "lookup",
      "find",
      JSON.stringify(described),
      "lookup",
    ];
    const encoded = new TextEncoder().encode(parts.join("\n"));
    expect(estimateInputTokens(request)).toBe(Math.ceil(encoded.byteLength / 4));
    expect(estimateInputTokens(estimatedRequest({ images: true }))).toBe(0);
  });
});
