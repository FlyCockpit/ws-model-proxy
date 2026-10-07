/**
 * The pool "Advanced" registry: every agent-editable pool setting that is automatic unless
 * overridden. One source for the web Advanced tab (labels and help live in the locale bundles
 * under `pool.advanced.<key>`), the oRPC/MCP input schemas (`packages/api/src/contracts`) and
 * the generated `pool_advanced_overrides_check` SQL (S0a). Defaults and bounds are the 0.4-dev
 * column defaults and CHECK bounds.
 *
 * Columns (`PoolAdvanced.maxWaitMs`, `contextCeiling`, `contextMargin`) are what admission reads
 * or fences on; every other key lives in the `PoolAdvanced.overrides` JSON. Absent or null means
 * automatic.
 */

export type RegistryUnit = "ms" | "s" | "minutes" | "tokens" | "bytes" | "percent";
export type RegistryAuto =
  /** A fixed built-in default. */
  | { default: number | boolean | string }
  /** Computed: observed engine fact or derived from other settings / server settings. */
  | { source: "engine" | "derived" };
export type RegistryEntry =
  | { kind: "int"; min: number; max: number; unit?: RegistryUnit; auto: RegistryAuto }
  | { kind: "number"; min: number; max: number; unit?: RegistryUnit; auto: RegistryAuto }
  | { kind: "bool"; auto: RegistryAuto }
  | { kind: "enum"; values: readonly string[]; auto: RegistryAuto };

/** Stored as `PoolAdvanced` columns. */
export const POOL_ADVANCED_COLUMNS = {
  /**
   * THE one queue wait (owner decision): a plain request is refused when it expires, an
   * `:external` request goes to the cloud. The cache-holder wait is derived from it.
   */
  maxWaitMs: { kind: "int", min: 0, max: 600_000, unit: "ms", auto: { default: 30_000 } },
  contextCeiling: {
    kind: "int",
    min: 1,
    max: 100_000_000,
    unit: "tokens",
    auto: { source: "derived" },
  },
  contextMargin: { kind: "int", min: 0, max: 1_000_000, unit: "tokens", auto: { default: 0 } },
} as const satisfies Record<string, RegistryEntry>;

/** Stored in `PoolAdvanced.overrides`, grouped as the Advanced tab shows them. */
export const POOL_ADVANCED_OVERRIDES = {
  affinity: {
    enabled: { kind: "bool", auto: { default: true } },
    ttlSeconds: { kind: "int", min: 60, max: 604_800, unit: "s", auto: { default: 3_600 } },
    maxRecords: { kind: "int", min: 100, max: 100_000, auto: { default: 10_000 } },
    prefixWeight: { kind: "int", min: 0, max: 10_000, auto: { default: 100 } },
    conversationWeight: { kind: "int", min: 0, max: 10_000, auto: { default: 150 } },
    confirmedCacheWeight: { kind: "int", min: 0, max: 10_000, auto: { default: 250 } },
    loadPenaltyWeight: { kind: "int", min: 0, max: 10_000, auto: { default: 100 } },
    residencyWeight: { kind: "int", min: 0, max: 10_000, auto: { default: 100 } },
  },
  protection: {
    enabled: { kind: "bool", auto: { default: true } },
    evictionFeedback: { kind: "bool", auto: { default: true } },
    windowSeconds: { kind: "int", min: 1, max: 3_600, unit: "s", auto: { default: 300 } },
    minTokens: { kind: "int", min: 0, max: 10_000_000, unit: "tokens", auto: { default: 8_192 } },
    share: {
      kind: "enum",
      values: ["equal_share", "first_come", "fixed_percent"],
      auto: { default: "equal_share" },
    },
    /** Used only with share `fixed_percent`. */
    fixedPercent: { kind: "int", min: 1, max: 100, unit: "percent", auto: { default: 50 } },
    /** The owner's own share (the owner has no share row). Automatic = the share mode. */
    ownerPercent: { kind: "int", min: 0, max: 100, unit: "percent", auto: { source: "derived" } },
  },
  /** Translate between OpenAI Chat, OpenAI Responses and Anthropic Messages when a member does
   * not serve the caller's protocol natively (native members always route first). */
  protocolAdaptation: { kind: "bool", auto: { default: true } },
  allowLossyDeveloperRoleCollapse: { kind: "bool", auto: { default: false } },
  recommendedSurface: {
    kind: "enum",
    values: ["openai_chat_completions", "openai_responses", "anthropic_messages"],
    auto: { source: "derived" },
  },
  /** Automatic = the server's media setting. */
  maxAttachmentBytes: {
    kind: "int",
    min: 0,
    max: 512 * 1024 * 1024,
    unit: "bytes",
    auto: { source: "derived" },
  },
  optimisticBasicTranscription: { kind: "bool", auto: { default: false } },
} as const satisfies Record<string, RegistryEntry | Record<string, RegistryEntry>>;
