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
  usageFactsFromProviderUsage,
  usageFactsFromRelayTerminal,
  UNKNOWN_USAGE_FACTS,
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
