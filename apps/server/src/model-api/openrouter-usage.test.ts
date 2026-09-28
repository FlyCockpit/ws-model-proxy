import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.SIGNUP_ENABLED ??= "true";
});

import openRouterFixture from "./fixtures/openrouter-usage.json";
import { providerBillableTokens } from "./provider-budget-accounting.js";
import { parsePricingSchedule } from "./provider-pricing.js";
import {
  type ProviderUsageDialect,
  parseProviderUsage,
  providerUsageDialect,
  usageFromObject,
} from "./public-overflow.js";

const encode = (value: string) => new TextEncoder().encode(value);
const nonStreamBody = () => [encode(JSON.stringify(openRouterFixture.nonStream))];
const streamBody = () => [encode(`${openRouterFixture.stream.join("\n\n")}\n\n`)];

/** The schedule an OpenRouter catalog import writes (`CATALOG_CHARGE_RULES`). */
function catalogPricing(rates: Record<string, string>) {
  const schedule = parsePricingSchedule({
    id: "pricing",
    version: "openrouter-import",
    currency: "USD",
    accountingVersion: "provider-billable-v1",
    confidence: "CALCULATED",
    effectiveAt: new Date("2026-09-01T00:00:00Z"),
    pricing: { ratesPerMillion: rates },
    chargeRules: {
      inputIncludesCacheRead: false,
      inputIncludesCacheWrite: false,
      outputIncludesReasoning: false,
      outputIncludesTool: false,
      reasoningAllowanceTokens: 0,
      toolAllowanceTokens: 0,
      cacheReadAllowanceTokens: 0,
      cacheWriteAllowanceTokens: 0,
      additionalAllowanceTokens: 0,
      unknownCategories: "FAIL_CLOSED",
    },
  });
  if (!schedule) throw new Error("expected a valid schedule");
  return schedule;
}

const fullRates = {
  input: "1",
  output: "4",
  cacheRead: "0.1",
  cacheWrite: "1.25",
  reasoning: "4",
};

describe("OpenRouter usage dialect", () => {
  it("maps only the openrouter provider type to the dialect", () => {
    expect(providerUsageDialect("openrouter")).toBe("openrouter");
    expect(providerUsageDialect(" OpenRouter ")).toBe("openrouter");
    for (const type of ["openai", "openai-compatible", "anthropic", "anthropic-compatible"])
      expect(providerUsageDialect(type)).toBe("generic");
    expect(providerUsageDialect(undefined)).toBe("generic");
  });

  it.each([
    ["non-stream", nonStreamBody],
    ["stream", streamBody],
  ])("normalizes the %s fixture into complete, priced categories", (_label, body) => {
    const pricing = catalogPricing(fullRates);
    const usage = parseProviderUsage(body(), pricing, "openrouter");
    expect(usage).toMatchObject({
      inputTokens: 600n,
      outputTokens: 50n,
      cacheReadTokens: 600n,
      cacheWriteTokens: 0n,
      reasoningTokens: 30n,
      additionalBillableTokens: 0n,
      reportedTotalTokens: 1280n,
      reportedCost: 0.0021,
      categoriesComplete: true,
    });
    expect(providerBillableTokens(usage!)).toBe(1280n);
    // 600*1 + 50*4 + 600*0.1 + 30*4 = 980 per million.
    expect(usage?.calculatedCost?.toString()).toBe("0.00098");
  });

  it("keeps positive cache writes unknown until a live capture verifies the subset (#62)", () => {
    const payload = structuredClone(openRouterFixture.nonStream);
    payload.usage.prompt_tokens_details.cache_write_tokens = 400;
    const usage = parseProviderUsage(
      [encode(JSON.stringify(payload))],
      catalogPricing(fullRates),
      "openrouter",
    );
    expect(usage?.categoriesComplete).toBe(false);
    expect(usage?.calculatedCost).toBeUndefined();
    expect(providerBillableTokens(usage!)).toBeUndefined();
  });

  it.each([
    "generic",
    // Every non-OpenRouter provider type resolves to the generic parser.
    providerUsageDialect("openai"),
    providerUsageDialect("openai-compatible"),
    providerUsageDialect("anthropic"),
    providerUsageDialect("anthropic-compatible"),
  ] as const)("fails the same payload closed for the %s dialect", (dialect) => {
    for (const body of [nonStreamBody(), streamBody()]) {
      const usage = parseProviderUsage(body, catalogPricing(fullRates), dialect);
      expect(usage?.categoriesComplete).toBe(false);
      expect(usage?.cacheWriteTokens).toBeUndefined();
      expect(usage?.calculatedCost).toBeUndefined();
      expect(providerBillableTokens(usage!)).toBeUndefined();
    }
  });

  const withUsage = (change: (usage: Record<string, unknown>) => void) => {
    const payload = structuredClone(openRouterFixture.nonStream) as {
      usage: Record<string, unknown>;
    };
    change(payload.usage);
    return usageFromObject(payload, "openrouter");
  };

  it.each<[string, (usage: Record<string, unknown>) => void]>([
    ["an unrecognized top-level key", (usage) => Object.assign(usage, { surprise_tokens: 1 })],
    [
      "an unrecognized prompt detail",
      (usage) => Object.assign(usage.prompt_tokens_details as object, { mystery_tokens: 3 }),
    ],
    [
      "an unrecognized completion detail",
      (usage) => Object.assign(usage.completion_tokens_details as object, { mystery_tokens: 3 }),
    ],
    [
      "an unrecognized cost detail",
      (usage) => Object.assign(usage.cost_details as object, { surprise_cost: 0.1 }),
    ],
    [
      "a negative cost detail",
      (usage) => Object.assign(usage.cost_details as object, { upstream_inference_cost: -1 }),
    ],
    ["a non-object cost_details", (usage) => Object.assign(usage, { cost_details: [0.1] })],
    ["a non-boolean is_byok", (usage) => Object.assign(usage, { is_byok: "yes" })],
    [
      "an unrecognized server tool counter",
      (usage) => Object.assign(usage, { server_tool_use: { code_runs: 1 } }),
    ],
    [
      "a fractional cache_write_tokens",
      (usage) => Object.assign(usage.prompt_tokens_details as object, { cache_write_tokens: 1.5 }),
    ],
    [
      "cache writes larger than the prompt",
      (usage) => Object.assign(usage.prompt_tokens_details as object, { cache_write_tokens: 700 }),
    ],
    [
      "a second cache-write spelling",
      (usage) => Object.assign(usage, { cache_creation_input_tokens: 400 }),
    ],
    [
      "a second prompt detail container hiding cache writes",
      (usage) => Object.assign(usage, { input_tokens_details: { cache_write_tokens: 1000 } }),
    ],
    [
      "a second prompt detail container hiding an unknown key",
      (usage) => Object.assign(usage, { input_tokens_details: { future_tokens: 999 } }),
    ],
    [
      "a second completion detail container",
      (usage) => Object.assign(usage, { output_tokens_details: { reasoning_tokens: 0 } }),
    ],
    [
      "a first-read detail container shadowing the real one",
      (usage) =>
        Object.assign(usage, {
          input_tokens_details: usage.prompt_tokens_details,
          prompt_tokens_details: { cached_tokens: 0 },
        }),
    ],
    [
      "an array prompt detail container",
      (usage) => Object.assign(usage, { prompt_tokens_details: [] }),
    ],
    [
      "a string completion detail container",
      (usage) => Object.assign(usage, { completion_tokens_details: "x" }),
    ],
    ["a second prompt count spelling", (usage) => Object.assign(usage, { input_tokens: 1200 })],
    ["a second completion count spelling", (usage) => Object.assign(usage, { output_tokens: 80 })],
    ["a second cost spelling", (usage) => Object.assign(usage, { total_cost: 0 })],
    [
      "a second cache-read spelling",
      (usage) => Object.assign(usage, { cache_read_input_tokens: 0 }),
    ],
    [
      "positive video tokens",
      (usage) => Object.assign(usage.prompt_tokens_details as object, { video_tokens: 5 }),
    ],
    [
      "positive image tokens",
      (usage) => Object.assign(usage.completion_tokens_details as object, { image_tokens: 5 }),
    ],
  ])("still fails closed on %s", (_label, change) => {
    expect(withUsage(change)?.categoriesComplete).toBe(false);
  });

  it("accepts is_byok, cost_details and server_tool_use only as metadata", () => {
    const usage = withUsage((value) =>
      Object.assign(value, {
        is_byok: true,
        cost_details: null,
        server_tool_use: { web_search_requests: 2 },
      }),
    );
    expect(usage).toMatchObject({
      inputTokens: 600n,
      outputTokens: 50n,
      categoriesComplete: true,
      reportedCost: 0.0021,
    });
    expect(usage?.rawUsage).toMatchObject({ is_byok: true });
  });

  it("produces byte-identical output for payloads without OpenRouter vocabulary", () => {
    const payloads: unknown[] = [
      { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      {
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          total_tokens: 30,
          prompt_tokens_details: { cached_tokens: 3, audio_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 2, audio_tokens: 1 },
          cost: 0.01,
        },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 7,
            output_tokens: 4,
            total_tokens: 11,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      },
      {
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
            output_tokens: 1,
          },
        },
      },
      { usage: { output_tokens: 7 } },
      { usage: { cost: "1.25", currency: "usd", pricing_version: "v2" } },
      { usage: { billable_tokens: 40, input_tokens: 10, output_tokens: 5 } },
      { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 9 } },
      { usage: { prompt_tokens: 3, completion_tokens: 1, unknown_key: 1 } },
      { usage: { prompt_tokens: -1, completion_tokens: 1 } },
    ];
    // Parser output at c689d6e (before #62), pinned so a change to the shared
    // generic parser cannot pass by moving both dialects together.
    const preDialectOutputs = [
      '{"inputTokens":"20n","outputTokens":"10n","reportedTotalTokens":"30n","categoriesComplete":true,"rawUsage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"12n","outputTokens":"7n","cacheReadTokens":"3n","reasoningTokens":"2n","additionalBillableTokens":"6n","reportedTotalTokens":"30n","categoriesComplete":true,"rawUsage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":3,"audio_tokens":5},"completion_tokens_details":{"reasoning_tokens":2,"audio_tokens":1},"cost":0.01},"reportedCost":0.01,"reportedCostSource":"provider-runtime","accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"5n","outputTokens":"3n","cacheReadTokens":"2n","reasoningTokens":"1n","reportedTotalTokens":"11n","categoriesComplete":true,"rawUsage":{"input_tokens":7,"output_tokens":4,"total_tokens":11,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"12n","outputTokens":"1n","cacheReadTokens":"3n","cacheWriteTokens":"4n","categoriesComplete":true,"rawUsage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"output_tokens":1},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"outputTokens":"7n","rawUsage":{"output_tokens":7},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"rawUsage":{"cost":"1.25","currency":"usd","pricing_version":"v2"},"reportedCost":"1.25","reportedCostCurrency":"USD","reportedCostPricingVersion":"v2","reportedCostSource":"provider-runtime","accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"10n","outputTokens":"5n","authoritativeBillableTokens":"40n","rawUsage":{"billable_tokens":40,"input_tokens":10,"output_tokens":5},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"3n","outputTokens":"1n","reportedTotalTokens":"9n","categoriesComplete":false,"rawUsage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":9},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"inputTokens":"3n","outputTokens":"1n","categoriesComplete":false,"rawUsage":{"prompt_tokens":3,"completion_tokens":1,"unknown_key":1},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
      '{"outputTokens":"1n","categoriesComplete":false,"rawUsage":{"prompt_tokens":-1,"completion_tokens":1},"accountingVersion":"provider-billable-v1","confidence":"REPORTED"}',
    ];
    const dialects: ProviderUsageDialect[] = ["generic", "openrouter"];
    for (const [index, payload] of payloads.entries()) {
      const [generic, openRouter] = dialects.map((dialect) =>
        JSON.stringify(usageFromObject(payload, dialect), (_key, value) =>
          typeof value === "bigint" ? `${value}n` : value,
        ),
      );
      expect(generic).toBe(preDialectOutputs[index]);
      expect(openRouter).toBe(generic);
      // The default parameter is the generic dialect.
      expect(
        JSON.stringify(usageFromObject(payload), (_key, value) =>
          typeof value === "bigint" ? `${value}n` : value,
        ),
      ).toBe(generic);
    }
  });
});
