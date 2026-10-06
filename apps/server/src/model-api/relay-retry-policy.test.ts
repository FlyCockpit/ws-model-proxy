import { describe, expect, it } from "vitest";
import {
  classifyEngineContextOverflow,
  isEngineContextOverflow,
  relayOperationRetrySafety,
  shouldRetryRelayOperation,
} from "./relay-retry-policy.js";

const failures = [
  "precommit_5xx",
  "precommit_transport",
  "precommit_content_type_mismatch",
  "precommit_context_exceeded",
] as const;

describe("relay retry policy", () => {
  it.each(failures)("never retries previous_response_id follow-ups for %s", (failure) => {
    const operation = {
      family: "responses",
      capability: "responses.create",
      additionalCapabilities: ["responses.statefulFollowUps"],
    };
    expect(relayOperationRetrySafety(operation)).toBe("never");
    expect(shouldRetryRelayOperation(operation, failure)).toBe(false);
  });

  it.each(["responses.statefulFollowUps"])("never retries %s", (capability) => {
    for (const failure of failures)
      expect(shouldRetryRelayOperation({ family: "responses", capability }, failure)).toBe(false);
  });

  it.each([
    ["responses.retrieve", "idempotent"],
    ["responses.delete", "idempotent"],
    ["responses.listInputItems", "idempotent"],
    ["responses.countTokens", "idempotent"],
    ["responses.create", "pre_commit_only"],
    ["responses.cancel", "pre_commit_only"],
    ["responses.compact", "pre_commit_only"],
    ["chat.create", "pre_commit_only"],
  ] as const)("allows safe precommit retry for %s", (capability, safety) => {
    const operation = {
      family: capability === "chat.create" ? "chat.completions" : "responses",
      capability,
    };
    expect(relayOperationRetrySafety(operation)).toBe(safety);
    for (const failure of failures)
      expect(shouldRetryRelayOperation(operation, failure)).toBe(true);
  });

  it.each([
    [
      400,
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens in the messages.",
          type: "BadRequestError",
        },
      }),
      true,
      40000,
      32768,
    ],
    [
      400,
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "This model's maximum context length is 8192 tokens.",
        },
      }),
      true,
      null,
      8192,
    ],
    [
      400,
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 200000 tokens > 200000 maximum",
        },
      }),
      true,
      null,
      null,
    ],
    [
      400,
      JSON.stringify({
        object: "error",
        message:
          "The input (41000 tokens) is longer than the model's context length (32768 tokens).",
        code: 400,
      }),
      true,
      41000,
      32768,
    ],
    [
      400,
      JSON.stringify({
        error: {
          message: "Invalid 'input': please keep under maximum context length",
          type: "invalid_request_error",
          param: "input",
        },
      }),
      false,
      null,
      null,
    ],
    [400, JSON.stringify({ error: { message: "unrelated bad request" } }), false, null, null],
    [500, JSON.stringify({ error: { message: "maximum context length" } }), false, null, null],
    [200, JSON.stringify({ error: { code: "context_length_exceeded" } }), false, null, null],
  ] as const)(
    "classifies engine context overflow %s",
    (status, body, expected, promptTokens, contextLength) => {
      const classified = classifyEngineContextOverflow(status, body);
      expect(classified.overflow).toBe(expected);
      expect(isEngineContextOverflow(status, body)).toBe(expected);
      if (expected) {
        expect(classified.promptTokens).toBe(promptTokens);
        expect(classified.contextLength).toBe(contextLength);
        expect(classified.snippet.length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    {
      engine: "vLLM max_tokens too large",
      body: JSON.stringify({
        error: {
          message:
            "'max_tokens' or 'max_completion_tokens' is too large: Please set it to be less than the model's context length. This model's maximum context length is 4096 tokens.",
        },
      }),
      overflow: true,
      promptTokens: null,
      requestedTokens: null,
      contextLength: 4096,
    },
    {
      engine: "vLLM decoder prompt vs max_model_len",
      body: JSON.stringify({
        error: {
          message:
            "The decoder prompt (length 5000) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.",
        },
      }),
      overflow: true,
      promptTokens: 5000,
      requestedTokens: null,
      contextLength: 4096,
    },
    {
      engine: "vLLM requested split messages/completion",
      body: JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.",
        },
      }),
      overflow: true,
      promptTokens: 4000,
      requestedTokens: 5000,
      contextLength: 4096,
    },
    {
      engine: "vLLM has N input tokens",
      body: JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 4096 tokens. However, your request has 5000 input tokens and 128 output tokens.",
        },
      }),
      overflow: true,
      promptTokens: 5000,
      requestedTokens: null,
      contextLength: 4096,
    },
    {
      engine: "SGLang maximum context length",
      body: JSON.stringify({
        object: "error",
        message:
          "Requested token count exceeds the model's maximum context length of 32768 tokens.",
        code: 400,
      }),
      overflow: true,
      promptTokens: null,
      requestedTokens: null,
      contextLength: 32768,
    },
    {
      engine: "llama.cpp input longer than context",
      body: JSON.stringify({
        error: {
          message:
            "The input (41000 tokens) is longer than the model's context length (32768 tokens).",
        },
      }),
      overflow: true,
      promptTokens: 41000,
      requestedTokens: null,
      contextLength: 32768,
    },
  ] as const)(
    "classifies $engine overflow strings",
    ({ body, overflow, promptTokens, requestedTokens, contextLength }) => {
      const classified = classifyEngineContextOverflow(400, body);
      expect(classified.overflow).toBe(overflow);
      expect(classified.promptTokens).toBe(promptTokens);
      expect(classified.requestedTokens).toBe(requestedTokens);
      expect(classified.contextLength).toBe(contextLength);
    },
  );
});
