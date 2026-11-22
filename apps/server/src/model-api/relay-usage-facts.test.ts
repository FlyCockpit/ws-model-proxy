import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false, WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://relay-usage-facts-test", NODE_ENV: "test" },
}));

const { ResponseUsageRecorder, USAGE_SAMPLE_TAIL_BYTES } = await import(
  "./response-usage-sample.js"
);
const {
  engineCacheConfirmedFromUsageFacts,
  reportedAffinityTokens,
  usageFactsFromProviderUsage,
  usageFactsFromRelayTerminal,
  UNKNOWN_USAGE_FACTS,
  withEstimatedUsage,
} = await import("./relay-usage-facts.js");
const { engineCacheConfirmedFromRetainedResponse } = await import("./public-overflow.js");

const encoder = new TextEncoder();

function sampleOf(...parts: string[]) {
  const recorder = new ResponseUsageRecorder();
  for (const part of parts) recorder.push(encoder.encode(part));
  return recorder.sample();
}

describe("ResponseUsageRecorder", () => {
  it("returns empty windows for an empty response", () => {
    expect(new ResponseUsageRecorder().sample()).toEqual({ prefix: [], tail: [], totalBytes: 0 });
  });

  it("keeps the bounded prefix and an SSE-aligned tail beyond the window", () => {
    const recorder = new ResponseUsageRecorder({ prefixBytes: 8, tailBytes: 16 });
    recorder.push(encoder.encode("data: aaaa\n\n"));
    recorder.push(encoder.encode("data: bbbbbbbb\n\n"));
    recorder.push(encoder.encode("data: {}\n\n"));
    const sample = recorder.sample();
    expect(new TextDecoder().decode(Buffer.concat(sample.prefix))).toBe("data: aa");
    const tail = new TextDecoder().decode(Buffer.concat(sample.tail));
    // The truncated window starts at the first complete event.
    expect(tail).toBe("data: {}\n\n");
    expect(sample.totalBytes).toBe(38);
  });
});

describe("reportedAffinityTokens", () => {
  it("sums prompt and completion when either is known", () => {
    expect(reportedAffinityTokens({ promptTokens: null, completionTokens: null })).toBeUndefined();
    expect(reportedAffinityTokens({ promptTokens: 12_000, completionTokens: 800 })).toBe(12_800);
    expect(reportedAffinityTokens({ promptTokens: 12_000, completionTokens: null })).toBe(12_000);
  });
});

describe("usageFactsFromRelayTerminal", () => {
  it("is unknown for an empty terminal", () => {
    expect(usageFactsFromRelayTerminal({ usageSample: null, usage: null })).toEqual(
      UNKNOWN_USAGE_FACTS,
    );
  });

  it("parses OpenAI chat usage with cached prompt tokens", () => {
    const facts = usageFactsFromRelayTerminal({
      usageSample: sampleOf(
        JSON.stringify({
          id: "chatcmpl",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        }),
      ),
      usage: null,
    });
    expect(facts).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 60,
      cacheWriteTokens: null,
      usageKnown: true,
    });
  });

  it("parses Anthropic streaming usage (input_tokens alias + cache fields in message_start)", () => {
    const facts = usageFactsFromRelayTerminal({
      usageSample: sampleOf(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      // The CLI-normalized usage lacks the input_tokens alias; server parsing wins.
      usage: { completionTokens: 42 },
    });
    expect(facts.usageKnown).toBe(true);
    expect(facts.promptTokens).toBe(95);
    expect(facts.completionTokens).toBe(42);
    expect(facts.cacheReadTokens).toBe(80);
    expect(facts.cacheWriteTokens).toBe(5);
    // Prompt-free: only integers leave the parser.
    expect(JSON.stringify(facts)).not.toContain("hi");
  });

  it("keeps early cache evidence from the prefix when the stream exceeds the tail window", () => {
    const filler = `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x".repeat(1024) } })}\n\n`;
    const parts = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":7,"output_tokens":1}}}\n\n',
      ...Array.from(
        { length: Math.ceil(USAGE_SAMPLE_TAIL_BYTES / filler.length) + 4 },
        () => filler,
      ),
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    ];
    const facts = usageFactsFromRelayTerminal({ usageSample: sampleOf(...parts), usage: null });
    expect(facts.cacheReadTokens).toBe(7);
    expect(facts.completionTokens).toBe(9);
  });

  it("falls back to CLI-normalized usage when the body carries none", () => {
    const facts = usageFactsFromRelayTerminal({
      usageSample: sampleOf("plain text transcript"),
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    });
    expect(facts).toEqual({
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      usageKnown: true,
    });
  });

  it("reports cache as not reported (null) when the upstream omits cache fields", () => {
    const facts = usageFactsFromRelayTerminal({
      usageSample: sampleOf(JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 2 } })),
      usage: null,
    });
    expect(facts.usageKnown).toBe(true);
    expect(facts.cacheReadTokens).toBeNull();
  });
});

describe("usageFactsFromProviderUsage", () => {
  it("maps provider-budget usage (bigint) into bounded integers", () => {
    expect(
      usageFactsFromProviderUsage({
        inputTokens: 10n,
        outputTokens: 4n,
        cacheReadTokens: 30n,
        cacheWriteTokens: undefined,
        reasoningTokens: 2n,
        reportedTotalTokens: undefined,
      }),
    ).toEqual({
      promptTokens: 40,
      completionTokens: 6,
      totalTokens: 46,
      cacheReadTokens: 30,
      cacheWriteTokens: null,
      usageKnown: true,
    });
    expect(usageFactsFromProviderUsage(undefined)).toEqual(UNKNOWN_USAGE_FACTS);
  });
});

describe("prompt and completion totals keep every token category", () => {
  const chat = (usage: Record<string, unknown>) =>
    usageFactsFromRelayTerminal({
      usageSample: sampleOf(JSON.stringify({ id: "chatcmpl", usage })),
      usage: null,
    });

  it("shows the provider's own counts for the pricing-test example (once 95/41)", () => {
    expect(
      chat({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20, audio_tokens: 5 },
        completion_tokens_details: {
          reasoning_tokens: 10,
          audio_tokens: 3,
          accepted_prediction_tokens: 4,
          rejected_prediction_tokens: 2,
        },
      }),
    ).toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it("keeps the Responses audio and prediction categories", () => {
    expect(
      usageFactsFromRelayTerminal({
        usageSample: sampleOf(
          JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 20,
                output_tokens: 12,
                total_tokens: 32,
                input_tokens_details: { cached_tokens: 3, audio_tokens: 2 },
                output_tokens_details: {
                  reasoning_tokens: 4,
                  audio_tokens: 1,
                  accepted_prediction_tokens: 2,
                  rejected_prediction_tokens: 1,
                },
              },
            },
          }),
        ),
        usage: null,
      }),
    ).toMatchObject({ promptTokens: 20, completionTokens: 12, totalTokens: 32 });
  });

  // Each category is a subset of the provider's prompt (100) or completion (50) count.
  it.each([
    ["input audio", { audio_tokens: 7 }, {}],
    ["output audio", {}, { audio_tokens: 7 }],
    ["accepted prediction", {}, { accepted_prediction_tokens: 7 }],
    ["rejected prediction", {}, { rejected_prediction_tokens: 7 }],
    ["reasoning", {}, { reasoning_tokens: 7 }],
    ["cache read", { cached_tokens: 7 }, {}],
  ])("adds %s back to its side", (_label, prompt, completion) => {
    expect(
      chat({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: prompt,
        completion_tokens_details: completion,
      }),
    ).toMatchObject({ promptTokens: 100, completionTokens: 50, usageKnown: true });
  });

  it("counts tool tokens as completion", () => {
    expect(
      usageFactsFromProviderUsage({
        inputTokens: 10n,
        outputTokens: 4n,
        toolTokens: 3n,
        additionalInputTokens: 2n,
        additionalOutputTokens: 5n,
      }),
    ).toMatchObject({ promptTokens: 12, completionTokens: 12, totalTokens: 24 });
  });
});

describe("engineCacheConfirmedFromUsageFacts", () => {
  it("is unknown (not a miss) when no usage was reported", () => {
    expect(engineCacheConfirmedFromUsageFacts(UNKNOWN_USAGE_FACTS)).toBeUndefined();
  });

  it("agrees with the retained-response parser it replaces on the pool path", () => {
    const cases = [
      // OpenAI hit / zero / not reported.
      [
        '{"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":4}}}',
      ],
      [
        '{"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}}}',
      ],
      ['{"usage":{"prompt_tokens":10,"completion_tokens":1}}'],
      // Anthropic streaming hit in message_start.
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":7,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
      ],
      // No usage at all.
      ['{"id":"x"}'],
    ];
    for (const parts of cases) {
      const sample = sampleOf(...parts);
      expect(
        engineCacheConfirmedFromUsageFacts(
          usageFactsFromRelayTerminal({ usageSample: sample, usage: null }),
        ),
      ).toBe(
        engineCacheConfirmedFromRetainedResponse(sample.prefix, sample.tail, sample.totalBytes),
      );
    }
  });
});

describe("withEstimatedUsage", () => {
  const unknown = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    usageKnown: false,
  };
  it("estimates a successful request's missing usage and marks it", () => {
    expect(withEstimatedUsage(unknown, { ok: true, metrics: { completionTokens: 7 } }, 12)).toEqual(
      {
        ...unknown,
        promptTokens: 12,
        completionTokens: 7,
        totalTokens: 19,
        usageEstimated: true,
      },
    );
  });
  it("never replaces reported usage or estimates a failure", () => {
    const known = { ...unknown, promptTokens: 3, usageKnown: true };
    expect(withEstimatedUsage(known, { ok: true, metrics: { completionTokens: 7 } }, 12)).toEqual({
      ...known,
      usageEstimated: false,
    });
    expect(withEstimatedUsage(unknown, { ok: false, metrics: null }, 12).usageEstimated).toBe(
      false,
    );
    expect(withEstimatedUsage(unknown, { ok: true, metrics: null }, undefined).usageEstimated).toBe(
      false,
    );
  });
});
