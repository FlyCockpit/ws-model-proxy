import { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.SIGNUP_ENABLED ??= "true";
});

import {
  calculatedCostForUsage,
  liabilityFromPricing,
  parsePricingSchedule,
} from "./provider-pricing.js";
import { parseProviderUsage, retainProviderUsageTail, usageFromObject } from "./public-overflow.js";

const pricing = parsePricingSchedule({
  id: "pricing",
  version: "2026-08-25",
  currency: "USD",
  accountingVersion: "provider-billable-v2",
  confidence: "CALCULATED",
  effectiveAt: new Date("2026-08-25T00:00:00Z"),
  pricing: {
    ratesPerMillion: {
      input: "2",
      output: "8",
      cacheRead: "0.5",
      cacheWrite: "2.5",
      reasoning: "8",
      tool: "4",
    },
  },
  chargeRules: {
    inputIncludesCacheRead: false,
    inputIncludesCacheWrite: false,
    outputIncludesReasoning: false,
    outputIncludesTool: false,
    reasoningAllowanceTokens: 100,
    toolAllowanceTokens: 50,
    cacheReadAllowanceTokens: 1_000,
    cacheWriteAllowanceTokens: 100,
    additionalAllowanceTokens: 0,
    unknownCategories: "FAIL_CLOSED",
  },
});

describe("provider pricing and usage accounting", () => {
  it("pins the schedule and includes known reasoning/tool upper bounds", () => {
    expect(pricing).toBeDefined();
    const liability = liabilityFromPricing({
      estimatedInputTokens: 1_000n,
      requestedOutputTokens: 500n,
      pricing,
    });
    expect(liability).toMatchObject({
      tokens: 2_750n,
      currency: "USD",
      pricingVersion: "2026-08-25",
      accountingVersion: "provider-billable-v2",
    });
    expect(new Prisma.Decimal(liability.spend!).toString()).toBe("0.00775");
  });

  it("de-duplicates OpenAI aggregate cached and reasoning token details", () => {
    const usage = usageFromObject({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 70n,
      cacheReadTokens: 30n,
      outputTokens: 30n,
      reasoningTokens: 10n,
      categoriesComplete: true,
    });
  });

  it("corroborates consistent totals and fails incomplete on mismatched aggregates", () => {
    expect(
      usageFromObject({
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    ).toMatchObject({ reportedTotalTokens: 15n, categoriesComplete: true });
    expect(
      usageFromObject({
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 30 },
      }),
    ).toMatchObject({ reportedTotalTokens: 30n, categoriesComplete: false });
  });

  it("reads Responses terminal usage nested under response", () => {
    expect(
      usageFromObject({
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 7 } },
      }),
    ).toMatchObject({ inputTokens: 11n, outputTokens: 7n, categoriesComplete: true });
  });

  it("rejects schedules without explicit category allowances", () => {
    const unsafe = parsePricingSchedule({
      id: "unsafe",
      version: "unsafe",
      currency: "USD",
      accountingVersion: "v1",
      confidence: "CALCULATED",
      effectiveAt: new Date(),
      pricing: { ratesPerMillion: { input: "1", output: "2" } },
      chargeRules: { unknownCategories: "FAIL_CLOSED" },
    });
    expect(unsafe).toBeUndefined();
    expect(
      liabilityFromPricing({
        estimatedInputTokens: 10n,
        requestedOutputTokens: 5n,
        pricing: unsafe,
      }),
    ).toEqual({ accountingVersion: "provider-billable-v1" });
  });

  it("never labels a locally calculated schedule cost as reported", () => {
    const locallyPriced = parsePricingSchedule({
      id: "local",
      version: "v1",
      currency: "USD",
      accountingVersion: "v1",
      confidence: "REPORTED",
      effectiveAt: new Date(),
      pricing: { ratesPerMillion: { input: "1", output: "2" } },
      chargeRules: {
        inputIncludesCacheRead: false,
        inputIncludesCacheWrite: false,
        outputIncludesReasoning: false,
        outputIncludesTool: false,
        cacheReadAllowanceTokens: 0,
        cacheWriteAllowanceTokens: 0,
        reasoningAllowanceTokens: 0,
        toolAllowanceTokens: 0,
        additionalAllowanceTokens: 0,
        unknownCategories: "FAIL_CLOSED",
      },
    });
    expect(locallyPriced?.confidence).toBe("CALCULATED");
  });

  it("keeps unknown usage and detail categories incomplete", () => {
    expect(
      usageFromObject({
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 1, audio_tokens: 3 },
        },
      })?.categoriesComplete,
    ).toBe(false);
    expect(
      usageFromObject({ usage: { input_tokens: 10, output_tokens: 2, mystery_tokens: 1 } })
        ?.categoriesComplete,
    ).toBe(false);
  });

  it("rejects invalid or negative provider-reported costs", () => {
    expect(
      usageFromObject({ usage: { input_tokens: 1, output_tokens: 1, cost: "oops" } })?.reportedCost,
    ).toBeUndefined();
    expect(
      usageFromObject({ usage: { input_tokens: 1, output_tokens: 1, cost: "-1" } })?.reportedCost,
    ).toBeUndefined();
  });

  it("preserves Anthropic cache categories and calculates category cost", () => {
    const usage = usageFromObject({
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    });
    expect(usage?.rawUsage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    });
    expect(calculatedCostForUsage(usage!, pricing!)?.toString()).toBe("0.0004225");
  });

  it("fails cost calculation closed when a reported category has no rate", () => {
    const incompletePricing = {
      ...pricing!,
      rates: { input: new Prisma.Decimal(1), output: new Prisma.Decimal(1) },
    };
    expect(
      calculatedCostForUsage(
        {
          inputTokens: 1n,
          outputTokens: 1n,
          cacheWriteTokens: 1n,
          categoriesComplete: true,
          accountingVersion: "v1",
          confidence: "REPORTED",
        },
        incompletePricing,
      ),
    ).toBeUndefined();
  });

  it("preserves all Anthropic SSE usage observations and numeric reported cost", () => {
    const chunks = [
      new TextEncoder().encode(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      ),
      new TextEncoder().encode(
        'data: {"type":"message_delta","usage":{"output_tokens":3,"cost":0.001,"currency":"usd"}}\n\n',
      ),
    ];
    expect(parseProviderUsage(chunks)).toMatchObject({
      inputTokens: 12n,
      outputTokens: 3n,
      reportedCost: 0.001,
      reportedCostCurrency: "USD",
      rawUsage: [{ input_tokens: 12 }, { output_tokens: 3, cost: 0.001, currency: "usd" }],
    });
  });

  it("reassembles multiline SSE events across arbitrary byte boundaries", () => {
    const wire = new TextEncoder().encode(
      'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"usage":{"input_tokens":9,"output_tokens":4}}}\r\n\r\n',
    );
    const chunks = [wire.slice(0, 17), wire.slice(17, 61), wire.slice(61, 97), wire.slice(97)];
    expect(parseProviderUsage(chunks)).toMatchObject({
      inputTokens: 9n,
      outputTokens: 4n,
      categoriesComplete: true,
    });
  });

  it("retains terminal SSE usage after more than 4 MiB of streamed content", () => {
    const retained: Uint8Array[] = [];
    let bytes = 0;
    bytes = retainProviderUsageTail(retained, bytes, new Uint8Array(4 * 1024 * 1024 + 128));
    bytes = retainProviderUsageTail(
      retained,
      bytes,
      new TextEncoder().encode(
        '\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":19,"output_tokens":6}}}\n\n',
      ),
    );
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(parseProviderUsage(retained)).toMatchObject({ inputTokens: 19n, outputTokens: 6n });
  });

  it("extracts terminal JSON usage from a bounded tail after more than 4 MiB", () => {
    const retained: Uint8Array[] = [];
    let bytes = retainProviderUsageTail(
      retained,
      0,
      new TextEncoder().encode(
        `{"content":"${"x".repeat(4 * 1024 * 1024)}","usage":{"input_tokens":23,"output_tokens":8}}`,
      ),
    );
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(parseProviderUsage(retained)).toMatchObject({ inputTokens: 23n, outputTokens: 8n });
  });
});
