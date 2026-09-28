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

  it.each([
    [
      "a usage object nested in usage",
      (usage: Record<string, unknown>) => ({
        usage: {
          ...usage,
          usage: { ...usage, cost: 0.000001, currency: "USD", pricing_version: "v" },
        },
      }),
    ],
    [
      "a sibling response.usage",
      (usage: Record<string, unknown>) => ({ usage, response: { usage } }),
    ],
    ["a sibling message", (usage: Record<string, unknown>) => ({ usage, message: { usage } })],
  ])("fails closed on %s (a second usage container)", (_label, envelope) => {
    const { usage } = structuredClone(openRouterFixture.nonStream) as {
      usage: Record<string, unknown>;
    };
    const ambiguous = usageFromObject(envelope(usage), "openrouter");
    expect(ambiguous?.categoriesComplete).toBe(false);
    // Evidence only: neither container's charge may settle.
    expect(ambiguous?.reportedCost).toBeUndefined();
    expect(ambiguous?.authoritativeBillableTokens).toBeUndefined();
    expect(usageFromObject({ usage }, "openrouter")?.categoriesComplete).toBe(true);
  });

  it("does not let an unreadable later usage record leave an earlier one to settle", () => {
    const frame = (usage: unknown) => encode(`data: ${JSON.stringify({ usage })}\n\n`);
    const first = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000001 };
    const usage = parseProviderUsage(
      [frame(first), frame(null), frame({ future_tokens: 5000 }), encode("data: [DONE]\n\n")],
      catalogPricing(fullRates),
      "openrouter",
    );
    expect(usage?.categoriesComplete).toBe(false);
    expect(usage?.reportedCost).toBeUndefined();
    expect(usage?.calculatedCost).toBeUndefined();
    // `usage: null` is absence, so a single observation still settles.
    const single = parseProviderUsage(
      [frame(null), frame(first), encode("data: [DONE]\n\n")],
      catalogPricing(fullRates),
      "openrouter",
    );
    expect(single?.categoriesComplete).toBe(true);
    expect(single?.reportedCost).toBe(0.000001);
  });

  describe("attribution grammar (design-openrouter-usage)", () => {
    const usage = () =>
      structuredClone(openRouterFixture.nonStream.usage) as unknown as Record<string, unknown>;
    const other = () => ({ ...usage(), completion_tokens: 90, total_tokens: 1290 });
    const chunk = (extra: Record<string, unknown>) =>
      JSON.stringify({
        id: "gen",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [],
        ...extra,
      });
    const sse = (records: string[], eol = "\n") =>
      records.map((record) => `${record}${eol}${eol}`).join("");
    const data = (extra: Record<string, unknown>) => `data: ${chunk(extra)}`;
    const content = `data: ${chunk({ choices: [{ index: 0, delta: { content: "x" } }], usage: null })}`;
    const done = "data: [DONE]";
    const body = (value: unknown) =>
      JSON.stringify({ ...openRouterFixture.nonStream, ...(value as object) });
    type Outcome = "settles" | "evidence" | "none";
    const rows: [string, string, Outcome][] = [
      ["one stream record", sse([content, data({ usage: usage() }), done]), "settles"],
      ["one non-stream body", body({}), "settles"],
      [
        "a byte-identical duplicate record",
        sse([data({ usage: usage() }), data({ usage: usage() }), done]),
        "settles",
      ],
      [
        "usage: null chunks around the record",
        sse([content, data({ usage: null }), data({ usage: usage() }), done]),
        "settles",
      ],
      [
        "usage before content (out of order)",
        sse([data({ usage: usage() }), content, done]),
        "settles",
      ],
      ["CRLF framing", sse([content, data({ usage: usage() }), done], "\r\n"), "settles"],
      ["CR framing", sse([content, data({ usage: usage() }), done], "\r"), "settles"],
      [
        "a usage-looking comment beside the record",
        sse([`: ${JSON.stringify({ usage: other() })}`, data({ usage: usage() }), done]),
        "settles",
      ],
      [
        "two distinct records",
        sse([data({ usage: other() }), data({ usage: usage() }), done]),
        "evidence",
      ],
      [
        "a later record with an unknown key",
        sse([data({ usage: usage() }), data({ usage: { future_tokens: 5 } }), done]),
        "evidence",
      ],
      [
        "a later total-only record",
        sse([data({ usage: usage() }), data({ usage: { total_tokens: 9 } }), done]),
        "evidence",
      ],
      [
        "a later root response container",
        sse([data({ usage: usage() }), data({ response: other() }), done]),
        "evidence",
      ],
      [
        "only a root message container",
        sse([data({ message: { usage: usage() } }), done]),
        "evidence",
      ],
      [
        "a nested usage.usage",
        sse([data({ usage: { ...other(), usage: usage() } }), done]),
        "evidence",
      ],
      [
        "a sibling response.usage",
        sse([data({ usage: usage(), response: { usage: other() } }), done]),
        "evidence",
      ],
      [
        "aliased detail containers",
        sse([data({ usage: { ...usage(), input_tokens_details: { cached_tokens: 0 } } }), done]),
        "evidence",
      ],
      [
        "aliased prompt counts",
        sse([data({ usage: { ...usage(), input_tokens: 1200 } }), done]),
        "evidence",
      ],
      [
        "a non-object detail container",
        sse([data({ usage: { ...usage(), completion_tokens_details: [] } }), done]),
        "evidence",
      ],
      [
        "an unknown top-level key",
        sse([data({ usage: { ...usage(), future_tokens: 1 } }), done]),
        "evidence",
      ],
      [
        "a string count",
        sse([data({ usage: { ...usage(), completion_tokens: "80" } }), done]),
        "evidence",
      ],
      [
        "positive cache writes",
        sse([
          data({
            usage: {
              ...usage(),
              prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 1 },
            },
          }),
          done,
        ]),
        "evidence",
      ],
      ["an array usage", sse([data({ usage: [usage()] }), done]), "evidence"],
      ["a total-only record", sse([data({ usage: { total_tokens: 1280 } }), done]), "evidence"],
      [
        "valid SSE and junk in one chunk (decoder rejects it: nothing read)",
        `${sse([data({ usage: usage() })])}{"usage":1}\n\n`,
        "none",
      ],
      [
        "usage only in a comment",
        sse([`: ${JSON.stringify({ usage: usage() })}`, content, done]),
        "none",
      ],
      ["no usage at all", sse([content, done]), "none"],
      ["a truncated non-stream body", body({}).slice(0, -40), "none"],
    ];

    it.each(rows.map(([label, wire, expected]) => ({ label, wire, expected })))(
      "$label → $expected",
      ({ wire, expected }) => {
        const parsed = parseProviderUsage([encode(wire)], catalogPricing(fullRates), "openrouter");
        if (expected === "none") {
          expect(parsed).toBeUndefined();
          return;
        }
        expect(parsed).toBeDefined();
        if (expected === "settles") {
          expect(parsed).toMatchObject({
            categoriesComplete: true,
            inputTokens: 600n,
            reportedCost: 0.0021,
          });
          expect(providerBillableTokens(parsed!)).toBe(1280n);
          expect(parsed?.calculatedCost?.toString()).toBe("0.00098");
        } else {
          expect(parsed?.categoriesComplete).toBe(false);
          expect(parsed?.reportedCost).toBeUndefined();
          expect(parsed?.calculatedCost).toBeUndefined();
          expect(parsed?.authoritativeBillableTokens).toBeUndefined();
          expect(providerBillableTokens(parsed!)).toBeUndefined();
        }
      },
    );

    it("keeps a record evidence when the stream stops being valid SSE after it", () => {
      const parsed = parseProviderUsage(
        [encode(sse([data({ usage: usage() })])), encode('{"usage":1}\n\n')],
        catalogPricing(fullRates),
        "openrouter",
      );
      expect(parsed?.categoriesComplete).toBe(false);
      expect(parsed?.reportedCost).toBeUndefined();
      expect(parsed?.calculatedCost).toBeUndefined();
    });
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
      // OpenRouter (Chat only) reads a root `usage` object; a Responses or
      // Anthropic nesting is evidence only in its dialect.
      if ((payload as { usage?: unknown }).usage !== undefined) expect(openRouter).toBe(generic);
      else expect(usageFromObject(payload, "openrouter")?.categoriesComplete).toBe(false);
      // The default parameter is the generic dialect.
      expect(
        JSON.stringify(usageFromObject(payload), (_key, value) =>
          typeof value === "bigint" ? `${value}n` : value,
        ),
      ).toBe(generic);
    }
  });
});
