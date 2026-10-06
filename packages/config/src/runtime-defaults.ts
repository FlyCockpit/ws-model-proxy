/**
 * The runtime "Advanced" registry: limits (`RuntimeVersion` columns read by admission) and the
 * `RuntimeVersion.advanced` JSON. Automatic unless overridden; effective value = override ??
 * instance-observed engine fact ?? default. Agent-editable through `runtime_create` /
 * `runtime_update` (`limits`, `advanced`); every edit is a new version and is adopted live by
 * running instances when the launch hash is unchanged.
 *
 * Health thresholds are a launch setting (`spec.launch.health`), not listed here.
 */
import type { RegistryEntry } from "./pool-defaults";

/** `RuntimeVersion` limit columns (per instance). Null = automatic. */
export const RUNTIME_LIMIT_COLUMNS = {
  concurrencyLimit: { kind: "int", min: 1, max: 10_000, auto: { source: "engine" } },
  contextLimit: {
    kind: "int",
    min: 1,
    max: 100_000_000,
    unit: "tokens",
    auto: { source: "engine" },
  },
  kvBudgetTokens: {
    kind: "int",
    min: 1,
    max: 1_000_000_000_000,
    unit: "tokens",
    auto: { source: "engine" },
  },
  kvFullThreshold: { kind: "number", min: 0.01, max: 1, auto: { default: 0.95 } },
  /** Column with a non-null default; "automatic" is AUTO. */
  engineLoadGate: {
    kind: "enum",
    values: ["auto", "enforce", "observe"],
    auto: { default: "auto" },
  },
} as const satisfies Record<string, RegistryEntry>;

/** `RuntimeVersion.advanced` keys. */
export const RUNTIME_ADVANCED = {
  countStrategy: {
    kind: "enum",
    values: [
      "tokenizer",
      "template_aware",
      "engine_reported",
      "conservative_estimate",
      "calibrated_estimate",
    ],
    auto: { default: "conservative_estimate" },
  },
  /** Automatic = derived from the served model's vision settings. */
  imageTokenAllowance: {
    kind: "int",
    min: 0,
    max: 1_000_000,
    unit: "tokens",
    auto: { source: "derived" },
  },
  maxAttachmentBytes: {
    kind: "int",
    min: 0,
    max: 512 * 1024 * 1024,
    unit: "bytes",
    auto: { source: "derived" },
  },
  /** Non-interactive automatic restarts allowed within the window. */
  restartBudget: { kind: "int", min: 0, max: 100, auto: { default: 3 } },
  restartWindowMin: { kind: "int", min: 1, max: 1_440, unit: "minutes", auto: { default: 60 } },
  /** UNHEALTHY this long → automatic restart. */
  unhealthyRestartMs: {
    kind: "int",
    min: 10_000,
    max: 86_400_000,
    unit: "ms",
    auto: { default: 120_000 },
  },
  /** A rank's node offline this long → the online ranks are stopped (multi-node). */
  unavailableStopMs: {
    kind: "int",
    min: 60_000,
    max: 86_400_000,
    unit: "ms",
    auto: { default: 900_000 },
  },
} as const satisfies Record<string, RegistryEntry>;
