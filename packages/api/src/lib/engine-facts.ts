import type { Prisma } from "@ws-model-proxy/db";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
} from "./capacity-policy-safety";

/** Relay 2.7 engine kinds, as the CLI names them. */
export const ENGINE_KIND_NAMES = [
  "generic",
  "llama.cpp",
  "vllm",
  "sglang",
  "ollama",
  "lm-studio",
] as const;
export type EngineKindName = (typeof ENGINE_KIND_NAMES)[number];

/** Prisma `EngineKind` values. */
export type EngineKind = "GENERIC" | "LLAMA_CPP" | "VLLM" | "SGLANG" | "OLLAMA" | "LM_STUDIO";
/** Prisma `EngineFactsSource` values. */
export type EngineFactsSource = "PROBE" | "CONFIG" | "MIXED" | "CUSTOM";
/** Prisma `EngineFactSource` values (per-fact provenance). */
export type EngineFactSource = "PROBE" | "CONFIG" | "CUSTOM";

type WireFact<T> = { value: T; source: "probe" | "config" | "custom" };

/** The relay 2.7 `engineFacts` object (validated by the relay's strict schema). */
export type WireEngineFacts = {
  engine?: WireFact<EngineKindName>;
  slots?: WireFact<number>;
  ctxPerSlot?: WireFact<number>;
  kvTokens?: WireFact<number>;
  maxModelLen?: WireFact<number>;
  hostPromptCacheMiB?: WireFact<number>;
  servedModelAliases?: WireFact<string[]>;
  loadAdapter?: {
    value: { input: "route" | "command"; signals: string[] };
    source: "config";
  };
};

/** Prisma `EngineLoadSource` values. */
export type EngineLoadSource = "BUILTIN" | "CUSTOM";

/** The facts an inference capacity stores (Int columns cap the numbers). */
export type StoredEngineFacts = {
  engineKind: EngineKind | null;
  engineSlots: number | null;
  engineSlotsSource: EngineFactSource | null;
  kvBudgetTokens: number | null;
  kvBudgetTokensSource: EngineFactSource | null;
  maxModelLen: number | null;
  maxModelLenSource: EngineFactSource | null;
  engineFactsSource: EngineFactsSource;
  engineLoadSource: EngineLoadSource | null;
  engineLoadSignals: string[];
};

const INT_COLUMN_MAX = 2 ** 31 - 1;

const KIND_TO_DB: Record<EngineKindName, EngineKind> = {
  generic: "GENERIC",
  "llama.cpp": "LLAMA_CPP",
  vllm: "VLLM",
  sglang: "SGLANG",
  ollama: "OLLAMA",
  "lm-studio": "LM_STUDIO",
};

export function engineKindToDb(kind: EngineKindName): EngineKind {
  return KIND_TO_DB[kind];
}

/**
 * The defaults for engines that expose no parallel count: Ollama runs one
 * request at a time unless told otherwise, LM Studio four.
 */
export function engineDefaultConcurrency(kind: EngineKindName | null | undefined): number | null {
  if (kind === "ollama") return 1;
  if (kind === "lm-studio") return 4;
  return null;
}

/** Endpoint facts with each model fact layered on top. */
export function mergeEngineFacts(
  endpoint: WireEngineFacts | undefined,
  model: WireEngineFacts | undefined,
): WireEngineFacts | undefined {
  if (!endpoint && !model) return undefined;
  return { ...endpoint, ...model };
}

function storedInt(fact: WireFact<number> | undefined): number | null {
  if (!fact || !Number.isInteger(fact.value) || fact.value < 1) return null;
  return Math.min(fact.value, INT_COLUMN_MAX);
}

function storedFactSource(source: WireFact<unknown>["source"]): EngineFactSource {
  if (source === "config") return "CONFIG";
  if (source === "custom") return "CUSTOM";
  return "PROBE";
}

function storedIntWithSource(fact: WireFact<number> | undefined): {
  value: number | null;
  source: EngineFactSource | null;
} {
  const value = storedInt(fact);
  if (value === null || !fact) return { value: null, source: null };
  return { value, source: storedFactSource(fact.source) };
}

/**
 * The capacity columns for one model's facts, or null when the CLI reported
 * none that a capacity stores. servedModelAliases is process identity proof
 * consumed by planEngineProcessCapacity directly from endpoint wire facts;
 * it must not be projected away before that decision.
 */
export function storedEngineFacts(facts: WireEngineFacts | undefined): StoredEngineFacts | null {
  if (!facts) return null;
  const slots = storedIntWithSource(facts.slots);
  const kv = storedIntWithSource(facts.kvTokens);
  const maxModelLen = storedIntWithSource(facts.maxModelLen);
  const stored = {
    engineKind: facts.engine ? engineKindToDb(facts.engine.value) : null,
    engineSlots: slots.value,
    engineSlotsSource: slots.source,
    kvBudgetTokens: kv.value,
    kvBudgetTokensSource: kv.source,
    maxModelLen: maxModelLen.value,
    maxModelLenSource: maxModelLen.source,
  };
  const sources = new Set(
    [facts.engine, facts.slots, facts.kvTokens, facts.maxModelLen]
      .filter((fact) => fact !== undefined)
      .map((fact) => fact.source),
  );
  if (sources.size === 0 && !facts.loadAdapter) return null;
  const signals = facts.loadAdapter?.value.signals.filter((signal) => signal.length > 0) ?? [];
  return {
    ...stored,
    engineFactsSource:
      sources.size === 0
        ? facts.loadAdapter
          ? "CONFIG"
          : "PROBE"
        : sources.size > 1
          ? "MIXED"
          : sources.has("config")
            ? "CONFIG"
            : sources.has("custom")
              ? "CUSTOM"
              : "PROBE",
    engineLoadSource: facts.loadAdapter ? "CUSTOM" : null,
    engineLoadSignals: signals,
  };
}

export function sameStoredEngineFacts(left: StoredEngineFacts, right: StoredEngineFacts): boolean {
  return (
    left.engineKind === right.engineKind &&
    left.engineSlots === right.engineSlots &&
    left.engineSlotsSource === right.engineSlotsSource &&
    left.kvBudgetTokens === right.kvBudgetTokens &&
    left.kvBudgetTokensSource === right.kvBudgetTokensSource &&
    left.maxModelLen === right.maxModelLen &&
    left.maxModelLenSource === right.maxModelLenSource &&
    left.engineFactsSource === right.engineFactsSource &&
    left.engineLoadSource === right.engineLoadSource &&
    left.engineLoadSignals.length === right.engineLoadSignals.length &&
    left.engineLoadSignals.every((signal, index) => signal === right.engineLoadSignals[index])
  );
}

/** One capacity's dependents, for checking a hard-limit refresh. */
export type HardLimitRefreshDependent =
  | { kind: "direct"; concurrencyLimit: number | null; reservedSlots: number }
  | {
      kind: "member";
      mode: "INHERIT" | "LIMITED" | "UNLIMITED";
      limit: number | null;
      reserved: number | null;
      poolLimit: number | null;
      poolReserved: number;
    };

/**
 * Whether engine-reported slots may replace an AUTO hard limit: every
 * direct and pool policy on the capacity must still fit (the same checks a
 * user edit of the limit passes).
 */
export function isHardLimitRefreshAdmissible(
  slots: number,
  dependents: readonly HardLimitRefreshDependent[],
): boolean {
  if (!Number.isInteger(slots) || slots < 1 || slots > 10_000) return false;
  try {
    for (const dependent of dependents) {
      if (dependent.kind === "direct") {
        assertDirectCapacityPolicy({
          hardLimit: slots,
          concurrencyLimit: dependent.concurrencyLimit,
          reservedSlots: dependent.reservedSlots,
          physicalMaxContext: null,
          contextCeiling: null,
          contextMargin: null,
        });
      } else {
        assertEffectiveConcurrencyPolicy({
          hardLimit: slots,
          poolLimit: dependent.poolLimit,
          poolReserved: dependent.poolReserved,
          memberMode: dependent.mode,
          memberLimit: dependent.limit,
          memberReserved: dependent.reserved,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes engine facts to a capacity and, while its hard limit is still
 * AUTO-sourced, refreshes that limit from the reported slots. A USER limit
 * (including USER null = unlimited) is never touched. The caller holds the
 * `06:capacity-policy:<target>` fence of every target on the capacity and the
 * `08:capacity:<capacity>` fence of the capacity itself
 * (`fences.capacityPolicy` / `fences.capacity`,
 * packages/db/src/capacity-lock-order.ts).
 */
export async function applyEngineFactsToCapacity(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    capacityId: string;
    facts: StoredEngineFacts;
    dependents: readonly HardLimitRefreshDependent[];
    now: Date;
  },
): Promise<{ limitRefreshed: boolean }> {
  await tx.inferenceCapacity.updateMany({
    where: { id: input.capacityId, userId: input.userId },
    data: { ...input.facts, engineFactsAt: input.now },
  });
  const slots = input.facts.engineSlots;
  if (slots === null || !isHardLimitRefreshAdmissible(slots, input.dependents)) {
    return { limitRefreshed: false };
  }
  const refreshed = await tx.inferenceCapacity.updateMany({
    where: {
      id: input.capacityId,
      userId: input.userId,
      hardConcurrencyLimitSource: "AUTO",
      NOT: { hardConcurrencyLimit: slots },
    },
    data: { hardConcurrencyLimit: slots, hardConcurrencyLimitSource: "AUTO" },
  });
  return { limitRefreshed: refreshed.count > 0 };
}

/** Display presets per engine (S-B stores and shows them; S-C and S-D use them). */
export type EnginePreset = {
  preset: "llama.cpp" | "vllm-sglang" | "ollama-lm-studio" | "generic";
  /** When a member counts as FULL. */
  fullWhen:
    | "active_at_slots"
    | "user_cap_or_engine_load"
    | "active_at_user_parallel"
    | "active_at_user_cap";
  /** What warm-session protection (S-C) counts. */
  protectionUnit: "slots" | "tokens";
};

export type EnginePresetOptions = {
  kvBudgetTokens?: number | null;
  loadSource?: EngineLoadSource | null;
};

export function enginePreset(
  kind: EngineKind | null | undefined,
  options?: EnginePresetOptions,
): EnginePreset {
  const preset = ((): EnginePreset => {
    switch (kind) {
      case "LLAMA_CPP":
        return { preset: "llama.cpp", fullWhen: "active_at_slots", protectionUnit: "slots" };
      case "VLLM":
      case "SGLANG":
        return {
          preset: "vllm-sglang",
          fullWhen: "user_cap_or_engine_load",
          protectionUnit: "tokens",
        };
      case "OLLAMA":
      case "LM_STUDIO":
        return {
          preset: "ollama-lm-studio",
          fullWhen: "active_at_user_parallel",
          protectionUnit: "slots",
        };
      default:
        return { preset: "generic", fullWhen: "active_at_user_cap", protectionUnit: "slots" };
    }
  })();
  const withLoad =
    options?.loadSource === "CUSTOM" && preset.fullWhen !== "user_cap_or_engine_load"
      ? { ...preset, fullWhen: "user_cap_or_engine_load" as const }
      : preset;
  if (
    kind !== "LLAMA_CPP" &&
    options?.kvBudgetTokens != null &&
    Number.isInteger(options.kvBudgetTokens) &&
    options.kvBudgetTokens > 0
  ) {
    return { ...withLoad, protectionUnit: "tokens" };
  }
  return withLoad;
}
