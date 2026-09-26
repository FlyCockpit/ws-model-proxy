import { describe, expect, it } from "vitest";
import { catalogEntry, liveShapedCatalogEntries } from "./fixtures/openrouter-catalog";
import { parseOpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";
import {
  CATALOG_CHARGE_RULES,
  CatalogParseError,
  catalogCompatibility,
  catalogModelIdSchema,
  catalogNativeCapabilities,
  catalogRatesPerMillion,
  type PoolCatalogProfile,
  parseCatalog,
  perTokenToPerMillion,
  searchCatalog,
  stableJson,
} from "./provider-catalog-model";

const profile = (overrides: Partial<PoolCatalogProfile> = {}): PoolCatalogProfile => ({
  contextCeiling: null,
  tools: false,
  imageInput: false,
  reasoning: false,
  ...overrides,
});

describe("parseCatalog", () => {
  it("trims each entry to the known fields and drops unknown ones", () => {
    const [model] = parseCatalog({ data: [catalogEntry()], extra: true });
    expect(model).toEqual({
      id: "qwen/qwen3-coder",
      name: "Qwen: Qwen3 Coder",
      contextLength: 262_144,
      maxCompletionTokens: 65_536,
      pricing: {
        prompt: "0.0000002",
        completion: "0.0000008",
        cacheRead: "0.00000002",
        cacheWrite: null,
        reasoning: null,
        variable: false,
        tiers: [],
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsTools: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
      expirationDate: null,
      moderated: false,
      free: false,
    });
    expect(JSON.stringify(model)).not.toContain("description");
  });

  it("drops entries with an invalid id and keeps the first of duplicate ids", () => {
    const models = parseCatalog({
      data: [
        catalogEntry({ id: "../etc/passwd" }),
        catalogEntry({ id: 42 }),
        null,
        catalogEntry({ name: "first" }),
        catalogEntry({ name: "second" }),
      ],
    });
    expect(models.map((model) => model.name)).toEqual(["first"]);
  });

  it("keeps a usable entry when optional fields are malformed", () => {
    const [model] = parseCatalog({
      data: [
        catalogEntry({
          name: 7,
          context_length: -5,
          pricing: { prompt: "abc", completion: "0.000001" },
          top_provider: "weird",
          supported_parameters: "tools",
          expiration_date: "soon",
        }),
      ],
    });
    expect(model).toMatchObject({
      name: "qwen/qwen3-coder",
      contextLength: null,
      maxCompletionTokens: null,
      pricing: { prompt: null, completion: "0.000001", variable: false },
      supportsTools: false,
      expirationDate: null,
    });
  });

  it("marks -1 pricing as variable and :free ids as free", () => {
    const [router, free] = parseCatalog({
      data: [
        catalogEntry({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }),
        catalogEntry({ id: "meta/llama-4:free", pricing: { prompt: "0", completion: "0" } }),
      ],
    });
    expect(router?.pricing).toMatchObject({ prompt: null, completion: null, variable: true });
    expect(free?.free).toBe(true);
  });

  it.each([
    [null],
    [{}],
    [{ data: "x" }],
    [{ data: [] }],
    [{ data: [{ id: "bad id" }] }],
    [{ data: Array.from({ length: 10_001 }, () => catalogEntry()) }],
  ])("rejects an unusable document %#", (json) => {
    expect(() => parseCatalog(json)).toThrow(CatalogParseError);
  });
});

describe("live-shaped catalog entries", () => {
  // Regression for the first parser: it dropped every `~` alias and ignored
  // `pricing.overrides`, importing the lowest tier as the ACTIVE price.
  const models = parseCatalog({ data: liveShapedCatalogEntries() });
  const byId = new Map(models.map((model) => [model.id, model]));

  it("keeps floating `~` aliases, tiered and extra-price-key entries", () => {
    expect(models.map((model) => model.id)).toEqual([
      "~openai/gpt-luna-latest",
      "tencent/hy3",
      "anthropic/claude-sonnet-5",
    ]);
    expect(byId.get("~openai/gpt-luna-latest")).toMatchObject({
      name: "OpenAI: GPT Luna Latest",
      contextLength: 1_050_000,
      pricing: {
        prompt: "0.0000001",
        variable: false,
        tiers: [
          {
            prompt: "0.0000002",
            completion: "0.00000075",
            cacheRead: "0.00000002",
            cacheWrite: "0.00000025",
            reasoning: null,
          },
        ],
      },
    });
    expect(JSON.stringify(models)).not.toContain("min_prompt_tokens");
    expect(JSON.stringify(models)).not.toContain("alias_target");
  });

  it("imports the upper bound across the base price and every tier", () => {
    const alias = byId.get("~openai/gpt-luna-latest");
    const timeOfDay = byId.get("tencent/hy3");
    const flat = byId.get("anthropic/claude-sonnet-5");
    if (!alias || !timeOfDay || !flat) throw new Error("fixture");
    // Long-prompt tier: 2x input, 1.5x output, 2x cache.
    expect(catalogRatesPerMillion(alias)).toEqual({
      input: "0.2",
      output: "0.75",
      cacheRead: "0.02",
      cacheWrite: "0.25",
      reasoning: "0.75",
    });
    // Time-of-day tier; cache writes are unpriced, so bounded by input.
    expect(catalogRatesPerMillion(timeOfDay)).toEqual({
      input: "0.132",
      output: "0.528",
      cacheRead: "0.033",
      cacheWrite: "0.132",
      reasoning: "0.528",
    });
    // Non-token keys (web_search, audio, 1h cache write) are not token rates.
    expect(catalogRatesPerMillion(flat)).toEqual({
      input: "3",
      output: "15",
      cacheRead: "0.3",
      cacheWrite: "3.75",
      reasoning: "15",
    });
  });

  it("warns nothing about price for a boundable tiered alias", () => {
    const alias = byId.get("~openai/gpt-luna-latest");
    if (!alias) throw new Error("fixture");
    expect(catalogCompatibility(alias, null).warn).toEqual(["MODERATED"]);
  });
});

describe("tiered pricing that cannot be bounded", () => {
  const tiered = (overrides: unknown) =>
    parseCatalog({
      data: [
        catalogEntry({
          pricing: { prompt: "0.000001", completion: "0.000002", overrides },
        }),
      ],
    })[0];

  it.each([
    ["a variable tier", [{ min_prompt_tokens: 1000, prompt: "-1" }]],
    ["a malformed tier price", [{ min_prompt_tokens: 1000, prompt: "lots" }]],
    ["a non-array overrides value", { prompt: "0.000009" }],
    ["a non-object tier", ["0.000009"]],
  ])("treats %s as unknown price (fail closed)", (_label, overrides) => {
    const model = tiered(overrides);
    if (!model) throw new Error("fixture");
    expect(model.pricing.variable).toBe(true);
    expect(catalogRatesPerMillion(model)).toBeNull();
    expect(catalogCompatibility(model, null).warn).toContain("UNKNOWN_PRICE");
  });

  it("ignores an empty or null overrides list", () => {
    for (const overrides of [[], null]) {
      const model = tiered(overrides);
      if (!model) throw new Error("fixture");
      expect(catalogRatesPerMillion(model)).toMatchObject({ input: "1", output: "2" });
    }
  });

  it("bounds a tier that omits a category by the base rate and the fallback", () => {
    const model = tiered([{ min_prompt_tokens: 1000, completion: "0.000004" }]);
    if (!model) throw new Error("fixture");
    expect(catalogRatesPerMillion(model)).toEqual({
      input: "1",
      output: "4",
      cacheRead: "1",
      cacheWrite: "1",
      reasoning: "4",
    });
  });
});

describe("catalogModelIdSchema", () => {
  it.each([
    "qwen/qwen3-coder",
    "meta/llama-4:free",
    "openai/gpt-6-luna-pro:batch",
    "a/b.c_d~e",
    "~openai/gpt-luna-latest",
    "~z-ai/glm-latest",
  ])("accepts %s verbatim", (value) => expect(catalogModelIdSchema.parse(value)).toBe(value));
  it.each([
    "qwen",
    "/qwen",
    "qwen/",
    "a b/c",
    "qwen/qwen coder",
    "x".repeat(256),
    "~~openai/x",
    "~/x",
    "~",
  ])("rejects %s", (value) => expect(catalogModelIdSchema.safeParse(value).success).toBe(false));
});

describe("searchCatalog", () => {
  const models = parseCatalog({
    data: [
      catalogEntry({ id: "vendor/alpha-coder", name: "Alpha Coder", context_length: 8_000 }),
      catalogEntry({
        id: "vendor/beta",
        name: "Beta Vision",
        supported_parameters: [],
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      }),
      catalogEntry({ id: "other/coder", name: "Other Coder" }),
      catalogEntry({ id: "vendor/coder", name: "Vendor Coder" }),
    ],
  });

  it("returns everything for an empty query, in catalog order", () => {
    expect(searchCatalog(models, { limit: 10 }).items.map((model) => model.id)).toEqual([
      "vendor/alpha-coder",
      "vendor/beta",
      "other/coder",
      "vendor/coder",
    ]);
  });

  it("matches every query token and ranks exact and prefix id matches first", () => {
    const result = searchCatalog(models, { query: "vendor/coder", limit: 10 });
    expect(result.items.map((model) => model.id)).toEqual(["vendor/coder"]);
    const ranked = searchCatalog(models, { query: "  CODER  ", limit: 10 });
    expect(ranked.items.map((model) => model.id)).toEqual([
      "vendor/alpha-coder",
      "other/coder",
      "vendor/coder",
    ]);
    expect(searchCatalog(models, { query: "coder vendor", limit: 10 }).total).toBe(2);
  });

  it("applies tools, minimum context and input-modality filters", () => {
    expect(
      searchCatalog(models, { filters: { tools: true }, limit: 10 }).items.map((m) => m.id),
    ).not.toContain("vendor/beta");
    expect(
      searchCatalog(models, { filters: { minContext: 100_000 }, limit: 10 }).items.map((m) => m.id),
    ).not.toContain("vendor/alpha-coder");
    expect(
      searchCatalog(models, { filters: { inputModalities: ["IMAGE"] }, limit: 10 }).items.map(
        (m) => m.id,
      ),
    ).toEqual(["vendor/beta"]);
  });

  it("pages with an offset cursor and caps the limit at 50", () => {
    const first = searchCatalog(models, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBe(3);
    const second = searchCatalog(models, { limit: 3, cursor: first.nextCursor ?? 0 });
    expect(second.items.map((model) => model.id)).toEqual(["vendor/coder"]);
    expect(second.nextCursor).toBeNull();
    expect(searchCatalog(models, { limit: 3, cursor: 99 }).items).toEqual([]);
    const many = parseCatalog({
      data: Array.from({ length: 80 }, (_, index) => catalogEntry({ id: `v/m${index}` })),
    });
    expect(searchCatalog(many, { limit: 500 }).items).toHaveLength(50);
  });
});

describe("catalogCompatibility", () => {
  const [base] = parseCatalog({ data: [catalogEntry()] });
  if (!base) throw new Error("fixture");

  it("is ok for a capable, priced model with no pool", () => {
    expect(catalogCompatibility(base, null)).toEqual({ verdict: "ok", block: [], warn: [] });
  });

  it("blocks a model without text output", () => {
    const [image] = parseCatalog({
      data: [
        catalogEntry({
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        }),
      ],
    });
    if (!image) throw new Error("fixture");
    expect(catalogCompatibility(image, null)).toMatchObject({
      verdict: "block",
      block: ["NO_TEXT_OUTPUT"],
    });
  });

  it("warns on each pool mismatch only when the pool advertises the feature", () => {
    const [weak] = parseCatalog({
      data: [catalogEntry({ supported_parameters: [], context_length: 8_000 })],
    });
    if (!weak) throw new Error("fixture");
    expect(catalogCompatibility(weak, profile()).warn).toEqual([]);
    expect(
      catalogCompatibility(
        weak,
        profile({ tools: true, imageInput: true, reasoning: true, contextCeiling: 32_000 }),
      ),
    ).toEqual({
      verdict: "warn",
      block: [],
      warn: ["NO_TOOLS", "SMALLER_CONTEXT", "NO_IMAGE_INPUT", "NO_REASONING"],
    });
    expect(catalogCompatibility(base, profile({ contextCeiling: 262_144 })).warn).toEqual([]);
  });

  it("warns on unknown context when the pool has a ceiling", () => {
    const [unknown] = parseCatalog({
      data: [catalogEntry({ context_length: null, top_provider: null })],
    });
    if (!unknown) throw new Error("fixture");
    expect(catalogCompatibility(unknown, profile({ contextCeiling: 1 })).warn).toEqual([
      "SMALLER_CONTEXT",
    ]);
  });

  it("warns on unknown price, free, expiring and moderated models without a pool", () => {
    const [risky] = parseCatalog({
      data: [
        catalogEntry({
          id: "x/y:free",
          pricing: { prompt: "-1", completion: "-1" },
          expiration_date: "2026-11-11",
          top_provider: { is_moderated: true },
        }),
      ],
    });
    if (!risky) throw new Error("fixture");
    expect(catalogCompatibility(risky, null).warn).toEqual([
      "UNKNOWN_PRICE",
      "FREE_MODEL",
      "EXPIRING",
      "MODERATED",
    ]);
  });
});

describe("pricing conversion", () => {
  it.each([
    ["0", "0"],
    ["0.000003", "3"],
    ["0.0000002", "0.2"],
    ["0.00000002", "0.02"],
    ["1", "1000000"],
    // Rounded up at 9 decimals so estimates never undercount.
    ["0.0000000833333333333333", "0.083333334"],
    ["0.000000000000001", "0.000000001"],
  ])("converts %s USD/token to %s USD/M", (value, expected) => {
    expect(perTokenToPerMillion(value)).toBe(expected);
  });

  it.each(["-1", "1e-6", "", "0.", ".5", "abc"])("rejects %s", (value) => {
    expect(perTokenToPerMillion(value)).toBeNull();
  });

  it("prices every usage category, falling back to the base rates", () => {
    const [model] = parseCatalog({ data: [catalogEntry()] });
    if (!model) throw new Error("fixture");
    expect(catalogRatesPerMillion(model)).toEqual({
      input: "0.2",
      output: "0.8",
      cacheRead: "0.02",
      cacheWrite: "0.2",
      reasoning: "0.8",
    });
    const rates = catalogRatesPerMillion(model);
    // Must satisfy the provider-management money-rate format.
    for (const value of Object.values(rates ?? {}))
      expect(value).toMatch(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u);
    expect(CATALOG_CHARGE_RULES.unknownCategories).toBe("FAIL_CLOSED");
  });

  it("returns null for variable or missing prices", () => {
    const [variable, missing] = parseCatalog({
      data: [
        catalogEntry({ id: "a/v", pricing: { prompt: "-1", completion: "-1" } }),
        catalogEntry({ id: "a/m", pricing: { prompt: "0.000001" } }),
      ],
    });
    if (!variable || !missing) throw new Error("fixture");
    expect(catalogRatesPerMillion(variable)).toBeNull();
    expect(catalogRatesPerMillion(missing)).toBeNull();
  });
});

describe("catalogNativeCapabilities", () => {
  it("builds a valid v4 Chat-Completions-only inventory from catalog facts", () => {
    const [model] = parseCatalog({
      data: [
        catalogEntry({
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        }),
      ],
    });
    if (!model) throw new Error("fixture");
    const inventory = catalogNativeCapabilities(model);
    expect(parseOpenAiCompatibleCapabilities(inventory)).not.toBeNull();
    expect(inventory).toMatchObject({
      version: 4,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: {
          operations: ["create"],
          streaming: true,
          maxContextTokens: 262_144,
          inputImages: true,
          tools: true,
          reasoning: true,
        },
      },
    });
    expect(Object.keys(inventory.version === 4 ? inventory.surfaces : {})).toEqual([
      "openaiChatCompletions",
    ]);
  });
});

describe("stableJson", () => {
  it("ignores key order and undefined values", () => {
    expect(stableJson({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: undefined } })).toBe(
      stableJson({ a: { d: [1, { e: 1, f: 2 }] }, b: 1 }),
    );
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
  });
});
