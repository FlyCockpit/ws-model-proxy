/**
 * Pure OpenRouter public-catalog model: parsing, search, compatibility
 * verdicts, and the conversions used by "import from catalog". No I/O, so the
 * browser may import the reason-code types.
 */
import { z } from "zod";
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
} from "./openai-compatible-capabilities";

export const CATALOG_MAX_MODELS = 10_000;
export const CATALOG_SEARCH_MAX_LIMIT = 50;

/**
 * Catalog ids are stored verbatim (they may contain `:`, e.g. `…:free`). One
 * leading `~` marks OpenRouter's floating family aliases such as
 * `~vendor/model-latest` ("always the latest model in the family"); they are
 * ordinary priced chat models and accepted wherever a catalog id is.
 */
export const catalogModelIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^~?[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9._~:@+-]+$/u);

// USD per token as a decimal string. "-1" means variable (router models).
const PRICE_PATTERN = /^(?:-1|\d{1,12}(?:\.\d{1,30})?)$/u;
const priceSchema = z.string().regex(PRICE_PATTERN).nullable().optional().catch(null);

/**
 * One `pricing.overrides` tier (prompt-length or time-of-day rates). Parsed
 * strictly: a malformed tier makes the whole price unknown instead of being
 * dropped, because dropping a higher tier would undercount spend.
 */
const strictPrice = z.string().regex(PRICE_PATTERN).nullable().optional();
const priceTierSchema = z.object({
  prompt: strictPrice,
  completion: strictPrice,
  input_cache_read: strictPrice,
  input_cache_write: strictPrice,
  internal_reasoning: strictPrice,
});
const priceTiersSchema = z.array(priceTierSchema).max(32);
const positiveInt = z
  .number()
  .int()
  .positive()
  .max(2 ** 31 - 1)
  .nullable()
  .optional()
  .catch(null);
const modalityList = z.array(z.string().trim().toLowerCase().max(32)).max(16).optional().catch([]);

/**
 * One catalog entry. zod strips unknown fields; malformed optional fields are
 * caught to null so one odd field does not drop an otherwise usable model, but
 * an invalid id drops the entry.
 */
const catalogEntrySchema = z.object({
  id: catalogModelIdSchema,
  name: z.string().trim().min(1).max(255).optional().catch(undefined),
  context_length: positiveInt,
  architecture: z
    .object({ input_modalities: modalityList, output_modalities: modalityList })
    .nullable()
    .optional()
    .catch(null),
  pricing: z
    .object({
      prompt: priceSchema,
      completion: priceSchema,
      input_cache_read: priceSchema,
      input_cache_write: priceSchema,
      internal_reasoning: priceSchema,
      overrides: z.unknown().optional(),
    })
    .nullable()
    .optional()
    .catch(null),
  top_provider: z
    .object({
      context_length: positiveInt,
      max_completion_tokens: positiveInt,
      is_moderated: z.boolean().optional().catch(undefined),
    })
    .nullable()
    .optional()
    .catch(null),
  supported_parameters: z.array(z.string().trim().max(64)).max(128).optional().catch([]),
  expiration_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]{0,30})?$/u)
    .nullable()
    .optional()
    .catch(null),
});

const catalogEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(CATALOG_MAX_MODELS),
});

/** USD per token, decimal strings; null when the catalog does not list it. */
export interface CatalogPriceTier {
  prompt: string | null;
  completion: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  reasoning: string | null;
}

export interface CatalogPricing extends CatalogPriceTier {
  /**
   * True when the price cannot be bounded: the catalog reports variable
   * pricing (`-1`, base or any tier) or lists malformed `overrides` tiers.
   */
  variable: boolean;
  /**
   * Higher-rate tiers from `pricing.overrides` (for example from 272k prompt
   * tokens, or by time of day). The base fields above are the lowest tier.
   */
  tiers: CatalogPriceTier[];
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  pricing: CatalogPricing;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  expirationDate: string | null;
  moderated: boolean;
  free: boolean;
}

export class CatalogParseError extends Error {
  constructor() {
    super("Provider catalog response is invalid");
    this.name = "CatalogParseError";
  }
}

function price(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "-1" ? null : value;
}

type RawPriceTier = {
  prompt?: string | null;
  completion?: string | null;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
  internal_reasoning?: string | null;
};

function priceTier(raw: RawPriceTier | null | undefined): CatalogPriceTier {
  return {
    prompt: price(raw?.prompt),
    completion: price(raw?.completion),
    cacheRead: price(raw?.input_cache_read),
    cacheWrite: price(raw?.input_cache_write),
    reasoning: price(raw?.internal_reasoning),
  };
}

function isVariable(raw: RawPriceTier | null | undefined): boolean {
  return [
    raw?.prompt,
    raw?.completion,
    raw?.input_cache_read,
    raw?.input_cache_write,
    raw?.internal_reasoning,
  ].includes("-1");
}

function catalogPricing(
  raw: (RawPriceTier & { overrides?: unknown }) | null | undefined,
): CatalogPricing {
  const base = priceTier(raw);
  if (raw?.overrides === undefined || raw.overrides === null)
    return { ...base, variable: raw?.prompt === "-1" || raw?.completion === "-1", tiers: [] };
  const tiers = priceTiersSchema.safeParse(raw.overrides);
  // Unparseable tiers cannot be bounded: the price is unknown (fail closed).
  if (!tiers.success) return { ...base, variable: true, tiers: [] };
  return {
    ...base,
    variable:
      raw.prompt === "-1" || raw.completion === "-1" || tiers.data.some((tier) => isVariable(tier)),
    tiers: tiers.data.map(priceTier),
  };
}

/** Parse and trim the catalog. Invalid entries are dropped, duplicates keep the first. */
export function parseCatalog(json: unknown): CatalogModel[] {
  const envelope = catalogEnvelopeSchema.safeParse(json);
  if (!envelope.success) throw new CatalogParseError();
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const raw of envelope.data.data) {
    const parsed = catalogEntrySchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const entry = parsed.data;
    seen.add(entry.id);
    const parameters = new Set(entry.supported_parameters ?? []);
    const pricing = entry.pricing ?? null;
    models.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      contextLength: entry.context_length ?? entry.top_provider?.context_length ?? null,
      maxCompletionTokens: entry.top_provider?.max_completion_tokens ?? null,
      pricing: catalogPricing(pricing),
      inputModalities: [...new Set(entry.architecture?.input_modalities ?? [])],
      outputModalities: [...new Set(entry.architecture?.output_modalities ?? [])],
      supportsTools: parameters.has("tools"),
      supportsReasoning: parameters.has("reasoning") || parameters.has("include_reasoning"),
      supportsStructuredOutput:
        parameters.has("structured_outputs") || parameters.has("response_format"),
      expirationDate: entry.expiration_date ?? null,
      moderated: entry.top_provider?.is_moderated === true,
      free: entry.id.endsWith(":free"),
    });
  }
  if (models.length === 0) throw new CatalogParseError();
  return models;
}

export interface CatalogSearchFilters {
  tools?: boolean;
  minContext?: number;
  inputModalities?: readonly string[];
}

export interface CatalogSearchInput {
  query?: string;
  filters?: CatalogSearchFilters;
  cursor?: number;
  limit: number;
}

/**
 * Case-insensitive token search over id and name. An exact id match ranks
 * first, then id-prefix matches; otherwise the catalog order is kept.
 * The cursor is an offset into the filtered result.
 */
export function searchCatalog(
  models: readonly CatalogModel[],
  input: CatalogSearchInput,
): { items: CatalogModel[]; nextCursor: number | null; total: number } {
  const query = (input.query ?? "").trim().toLowerCase();
  const tokens = query.split(/\s+/u).filter(Boolean);
  const filters = input.filters ?? {};
  const required = (filters.inputModalities ?? []).map((value) => value.toLowerCase());
  const matches = models.filter((model) => {
    const haystack = `${model.id} ${model.name}`.toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) return false;
    if (filters.tools === true && !model.supportsTools) return false;
    if (
      filters.minContext !== undefined &&
      (model.contextLength === null || model.contextLength < filters.minContext)
    )
      return false;
    return required.every((modality) => model.inputModalities.includes(modality));
  });
  const rank = (model: CatalogModel) => {
    const id = model.id.toLowerCase();
    if (query && id === query) return 0;
    if (query && id.startsWith(query)) return 1;
    return 2;
  };
  const ranked = matches
    .map((model, index) => ({ model, index, rank: rank(model) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ model }) => model);
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), CATALOG_SEARCH_MAX_LIMIT);
  const start = Math.max(0, Math.trunc(input.cursor ?? 0));
  const items = ranked.slice(start, start + limit);
  const next = start + items.length;
  return { items, nextCursor: next < ranked.length ? next : null, total: ranked.length };
}

/** What the pool's primaries advertise; the external equivalent is compared against it. */
export interface PoolCatalogProfile {
  contextCeiling: number | null;
  tools: boolean;
  imageInput: boolean;
  reasoning: boolean;
}

export const catalogBlockReasons = ["NO_TEXT_OUTPUT"] as const;
export const catalogWarnReasons = [
  "NO_TOOLS",
  "SMALLER_CONTEXT",
  "NO_IMAGE_INPUT",
  "NO_REASONING",
  "UNKNOWN_PRICE",
  "FREE_MODEL",
  "EXPIRING",
  "MODERATED",
] as const;
export type CatalogBlockReason = (typeof catalogBlockReasons)[number];
export type CatalogWarnReason = (typeof catalogWarnReasons)[number];
export type CatalogVerdict = "ok" | "warn" | "block";

export interface CatalogCompatibility {
  verdict: CatalogVerdict;
  block: CatalogBlockReason[];
  warn: CatalogWarnReason[];
}

/**
 * Advisory verdict. Pool-independent checks always run; pool comparisons run
 * only with a profile. Runtime compatibility checks stay authoritative.
 */
export function catalogCompatibility(
  model: CatalogModel,
  profile: PoolCatalogProfile | null,
): CatalogCompatibility {
  const block: CatalogBlockReason[] = [];
  const warn: CatalogWarnReason[] = [];
  // The only native surface claimed for OpenRouter is Chat Completions, which
  // needs text output; the protocol itself is always resolvable here.
  if (!model.outputModalities.includes("text")) block.push("NO_TEXT_OUTPUT");
  if (profile) {
    if (profile.tools && !model.supportsTools) warn.push("NO_TOOLS");
    if (
      profile.contextCeiling !== null &&
      (model.contextLength === null || model.contextLength < profile.contextCeiling)
    )
      warn.push("SMALLER_CONTEXT");
    if (profile.imageInput && !model.inputModalities.includes("image")) warn.push("NO_IMAGE_INPUT");
    if (profile.reasoning && !model.supportsReasoning) warn.push("NO_REASONING");
  }
  if (catalogRatesPerMillion(model) === null) warn.push("UNKNOWN_PRICE");
  if (model.free) warn.push("FREE_MODEL");
  if (model.expirationDate !== null) warn.push("EXPIRING");
  if (model.moderated) warn.push("MODERATED");
  return { verdict: block.length ? "block" : warn.length ? "warn" : "ok", block, warn };
}

const MONEY_SCALE = 9;

/** USD per token → units of 1e-9 USD per million tokens, rounded up. */
function perTokenToUnits(value: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,30}))?$/u.exec(value);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const digits = BigInt(`${whole}${fraction}`);
  // units of 1e-9 USD per million = value * 1e6 * 1e9 = digits * 10^(15 - scale)
  const exponent = 6 + MONEY_SCALE - fraction.length;
  return exponent >= 0
    ? digits * 10n ** BigInt(exponent)
    : (digits + 10n ** BigInt(-exponent) - 1n) / 10n ** BigInt(-exponent);
}

function unitsToDecimal(units: bigint): string {
  const integer = units / 10n ** BigInt(MONEY_SCALE);
  const remainder = (units % 10n ** BigInt(MONEY_SCALE))
    .toString()
    .padStart(MONEY_SCALE, "0")
    .replace(/0+$/u, "");
  return remainder ? `${integer}.${remainder}` : integer.toString();
}

/**
 * USD per token → USD per million tokens with exact decimal arithmetic (no
 * floats), rounded UP to the 9 decimals a stored rate allows. Rounding only
 * ever raises one listed per-token rate; it does not make an imported price
 * an upper bound by itself (see `catalogRatesPerMillion` for tiers).
 */
export function perTokenToPerMillion(value: string): string | null {
  const units = perTokenToUnits(value);
  return units === null ? null : unitsToDecimal(units);
}

export type CatalogRatesPerMillion = {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  reasoning: string;
};

/**
 * JSON with object keys sorted recursively. Postgres `jsonb` does not keep key
 * order, so stored and freshly built documents are compared through this.
 */
export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

function maxUnits(values: readonly bigint[]): bigint {
  return values.reduce((highest, value) => (value > highest ? value : highest));
}

/**
 * Pricing schedule rates for an imported model, or null when the price is
 * unknown or variable (no ACTIVE price is then written, so SPEND rules fail
 * closed with PRICING_UNAVAILABLE).
 *
 * The schedule has one rate per token category, but OpenRouter bills some
 * models in tiers (`pricing.overrides`, e.g. 2x input from 272k prompt tokens,
 * or by time of day). Each category's rate is therefore the upper bound across
 * the base price and every tier, so the calculated cost of any token-priced
 * request is never below what OpenRouter charges for those tokens. It does not
 * cover non-token charges (web search, images, audio, per-request fees); the
 * FAIL_CLOSED rule covers usage categories the schedule does not price.
 *
 * The usage parser reports cache reads/writes and reasoning separately from
 * input and output, so each gets an explicit rate. A tier that does not price
 * one of them is bounded by the input (cache) or output (reasoning) upper
 * bound, the rate OpenRouter otherwise bills those tokens at.
 */
export function catalogRatesPerMillion(model: CatalogModel): CatalogRatesPerMillion | null {
  const pricing = model.pricing;
  if (pricing.variable || pricing.prompt === null || pricing.completion === null) return null;
  const tiers: CatalogPriceTier[] = [pricing, ...pricing.tiers];
  const units = (value: string | null) => (value === null ? null : perTokenToUnits(value));
  const bound = (key: keyof CatalogPriceTier, fallback: bigint | null): bigint | null => {
    const values: bigint[] = [];
    for (const tier of tiers) {
      const value = units(tier[key]);
      if (value !== null) values.push(value);
      else if (tier[key] !== null) return null;
      else if (fallback !== null) values.push(fallback);
    }
    return values.length > 0 ? maxUnits(values) : null;
  };
  // Prompt and completion always exist on the base tier; a tier that omits
  // them inherits the base rate, which is already in the bound.
  const input = bound("prompt", null);
  const output = bound("completion", null);
  if (input === null || output === null) return null;
  const cacheRead = bound("cacheRead", input);
  const cacheWrite = bound("cacheWrite", input);
  const reasoning = bound("reasoning", output);
  if (cacheRead === null || cacheWrite === null || reasoning === null) return null;
  return {
    input: unitsToDecimal(input),
    output: unitsToDecimal(output),
    cacheRead: unitsToDecimal(cacheRead),
    cacheWrite: unitsToDecimal(cacheWrite),
    reasoning: unitsToDecimal(reasoning),
  };
}

/** Charge rules matching `catalogRatesPerMillion`: every category priced explicitly. */
export const CATALOG_CHARGE_RULES = {
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
} as const;

/**
 * v4 native inventory for an imported OpenRouter model: Chat Completions only
 * (the only OpenRouter surface WSMP claims), with catalog-derived features.
 */
export function catalogNativeCapabilities(model: CatalogModel): OpenAiCompatibleCapabilities {
  const input = new Set(model.inputModalities);
  const output = new Set(model.outputModalities);
  const inventory = {
    version: 4,
    protocol: "openai-compatible",
    source: "provider",
    confidence: "high",
    surfaces: {
      openaiChatCompletions: {
        source: "provider",
        confidence: "high",
        operations: ["create"],
        streaming: true,
        ...(model.contextLength !== null ? { maxContextTokens: model.contextLength } : {}),
        inputImages: input.has("image"),
        inputAudio: input.has("audio"),
        inputVideo: input.has("video"),
        outputImages: output.has("image"),
        outputAudio: output.has("audio"),
        tools: model.supportsTools,
        structuredOutput: model.supportsStructuredOutput,
        reasoning: model.supportsReasoning,
      },
    },
  };
  const parsed = parseOpenAiCompatibleCapabilities(inventory);
  if (!parsed) throw new CatalogParseError();
  return parsed;
}
