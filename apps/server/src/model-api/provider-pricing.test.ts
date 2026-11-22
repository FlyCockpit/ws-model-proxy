import { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.SIGNUP_ENABLED ??= "true";
});

import { additionalBillableTokens, providerBillableTokens } from "./provider-budget-accounting.js";
import {
  calculatedCostForUsage,
  liabilityFromPricing,
  parsePricingSchedule,
} from "./provider-pricing.js";
import {
  mergeProviderUsage,
  parseProviderUsage,
  retainProviderUsageTail,
  usageFromObject,
} from "./public-overflow.js";

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
    // 1000 input at the cache-write rate 2.5 (an input token may be a cache write), 500 output
    // at 8, plus the allowances: (2500 + 4000 + 800 + 200 + 500 + 250) / 1e6.
    expect(new Prisma.Decimal(liability.spend!).toString()).toBe("0.00825");
  });

  it("reserves at least what any reply within the bounds can cost, dearer categories included", () => {
    // A catalog import: reasoning dearer than output, cache writes dearer than input, and no
    // allowance for either (all within the input estimate and the output bound).
    const dearer = parsePricingSchedule({
      id: "dearer",
      version: "v1",
      currency: "USD",
      accountingVersion: "provider-billable-v1",
      confidence: "CALCULATED",
      effectiveAt: new Date("2026-08-25T00:00:00Z"),
      pricing: {
        ratesPerMillion: { input: "1", output: "1", reasoning: "10", cacheWrite: "1.25" },
      },
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
    if (!dearer) throw new Error("expected a schedule");
    const liability = liabilityFromPricing({
      estimatedInputTokens: 1_000n,
      requestedOutputTokens: 1_000n,
      pricing: dearer,
    });
    // The dearest reply the bounds allow: every input token a cache write, every output token
    // reasoning.
    const worst = calculatedCostForUsage(
      {
        inputTokens: 0n,
        cacheWriteTokens: 1_000n,
        outputTokens: 0n,
        reasoningTokens: 1_000n,
        categoriesComplete: true,
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
      },
      dearer,
    );
    expect(worst?.toString()).toBe("0.01125");
    expect(new Prisma.Decimal(liability.spend!).greaterThanOrEqualTo(worst!)).toBe(true);
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

  it("normalizes Chat audio and prediction detail categories without double counting", () => {
    const usage = usageFromObject({
      usage: {
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
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 75n,
      cacheReadTokens: 20n,
      outputTokens: 31n,
      reasoningTokens: 10n,
      additionalInputTokens: 5n,
      additionalOutputTokens: 9n,
      reportedTotalTokens: 150n,
      categoriesComplete: true,
    });
    expect(usage?.rawUsage).toMatchObject({
      prompt_tokens_details: { audio_tokens: 5 },
      completion_tokens_details: {
        audio_tokens: 3,
        accepted_prediction_tokens: 4,
        rejected_prediction_tokens: 2,
      },
    });
  });

  it("prices both additional sides at the one additional rate, as the mixed total was", () => {
    const withAdditional = parsePricingSchedule({
      id: "audio",
      version: "v1",
      currency: "USD",
      accountingVersion: "provider-billable-v1",
      confidence: "CALCULATED",
      effectiveAt: new Date("2026-08-25T00:00:00Z"),
      pricing: {
        ratesPerMillion: {
          input: "1",
          output: "2",
          cacheRead: "0.5",
          reasoning: "2",
          additional: "100",
        },
      },
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
    if (!withAdditional) throw new Error("expected a schedule");
    // The pricing-test example: 75*1 + 20*0.5 + 31*2 + 10*2 + (5 + 9)*100 = 1567 per million.
    const usage = usageFromObject({
      usage: {
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
      },
    });
    expect(calculatedCostForUsage(usage!, withAdditional)?.toString()).toBe("0.001567");
    expect(providerBillableTokens(usage!)).toBe(150n);
  });

  it("replaces both additional sides together when a later observation overlays an earlier one", () => {
    // Two observations of one reply: the first reports input audio, the second only output
    // audio. The second's counts win as a whole, as the single mixed total did: 20 + 9 + 1.
    const first = {
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        prompt_tokens_details: { audio_tokens: 2 },
      },
    };
    const second = {
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        completion_tokens_details: { audio_tokens: 1 },
      },
    };
    const expected = {
      inputTokens: 20n,
      outputTokens: 9n,
      additionalInputTokens: 0n,
      additionalOutputTokens: 1n,
      categoriesComplete: true,
    };
    const streamed = parseProviderUsage([
      Buffer.from(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`),
    ]);
    const merged = mergeProviderUsage(usageFromObject(first), usageFromObject(second));
    for (const usage of [streamed, merged]) {
      expect(usage).toMatchObject(expected);
      expect(providerBillableTokens(usage!)).toBe(30n);
      expect(additionalBillableTokens(usage!)).toBe(1n);
    }
  });

  it("keeps an observation of only unknown categories as evidence that fails closed", () => {
    const counted = { usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const unknownOnly = { usage: { additional_billable_tokens: 3 } };
    expect(usageFromObject(unknownOnly)).toMatchObject({
      inputTokens: undefined,
      outputTokens: undefined,
      categoriesComplete: false,
      rawUsage: { additional_billable_tokens: 3 },
    });
    const streamed = parseProviderUsage(
      [Buffer.from(`data: ${JSON.stringify(counted)}\n\ndata: ${JSON.stringify(unknownOnly)}\n\n`)],
      pricing,
    );
    const merged = mergeProviderUsage(usageFromObject(counted), usageFromObject(unknownOnly));
    for (const usage of [streamed, merged]) {
      expect(usage).toMatchObject({
        inputTokens: 10n,
        outputTokens: 5n,
        categoriesComplete: false,
      });
      expect(usage?.calculatedCost).toBeUndefined();
      expect(providerBillableTokens(usage!)).toBeUndefined();
    }
  });

  it("still ignores a Responses event whose response carries no usage", () => {
    const created = { type: "response.created", response: { id: "resp", status: "in_progress" } };
    const completed = {
      type: "response.completed",
      response: { id: "resp", usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
    };
    expect(usageFromObject(created)).toBeUndefined();
    expect(
      parseProviderUsage(
        [Buffer.from(`data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\n`)],
        pricing,
      ),
    ).toMatchObject({ inputTokens: 7n, outputTokens: 3n, categoriesComplete: true });
  });

  it("fails closed on an additional count without a side", () => {
    // No provider sends an undirected `additional_billable_tokens`; it is an unknown key,
    // so the categories are incomplete and no cost is calculated from them.
    expect(
      usageFromObject({
        usage: { prompt_tokens: 10, completion_tokens: 5, additional_billable_tokens: 3 },
      }),
    ).toMatchObject({
      inputTokens: 10n,
      outputTokens: 5n,
      additionalInputTokens: undefined,
      additionalOutputTokens: undefined,
      categoriesComplete: false,
    });
  });

  it("normalizes Responses audio and prediction detail categories", () => {
    expect(
      usageFromObject({
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
    ).toMatchObject({
      inputTokens: 15n,
      outputTokens: 4n,
      cacheReadTokens: 3n,
      reasoningTokens: 4n,
      additionalInputTokens: 2n,
      additionalOutputTokens: 4n,
      categoriesComplete: true,
    });
  });

  it("recognizes Responses output details even when input details are omitted", () => {
    expect(
      usageFromObject({
        usage: {
          input_tokens: 7,
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 4, audio_tokens: 1 },
        },
      }),
    ).toMatchObject({
      inputTokens: 7n,
      outputTokens: 5n,
      reasoningTokens: 4n,
      additionalOutputTokens: 1n,
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

  it("prices explicit zero cache allowances without requiring unused cache rates", () => {
    const zeroCache = parsePricingSchedule({
      id: "zero-cache",
      version: "v1",
      currency: "USD",
      accountingVersion: "v1",
      confidence: "CALCULATED",
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
    expect(
      liabilityFromPricing({
        estimatedInputTokens: 10n,
        requestedOutputTokens: 5n,
        pricing: zeroCache,
      }).spend?.toString(),
    ).toBe("0.00002");
  });

  it("keeps unknown usage and detail categories incomplete", () => {
    expect(
      usageFromObject({
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 1, future_tokens: 3 },
        },
      })?.categoriesComplete,
    ).toBe(false);
    expect(
      usageFromObject({ usage: { input_tokens: 10, output_tokens: 2, mystery_tokens: 1 } })
        ?.categoriesComplete,
    ).toBe(false);
    expect(
      usageFromObject({
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          input_tokens_details: { audio_tokens: "invalid" },
        },
      })?.categoriesComplete,
    ).toBe(false);
    expect(
      usageFromObject({
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          input_tokens_details: { audio_tokens: 3 },
        },
      })?.categoriesComplete,
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
