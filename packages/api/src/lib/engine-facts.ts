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
export type EngineFactsSource = "PROBE" | "CONFIG" | "MIXED";

type WireFact<T> = { value: T; source: "probe" | "config" };

/** The relay 2.7 `engineFacts` object (validated by the relay's strict schema). */
export type WireEngineFacts = {
  engine?: WireFact<EngineKindName>;
  slots?: WireFact<number>;
  ctxPerSlot?: WireFact<number>;
  kvTokens?: WireFact<number>;
  maxModelLen?: WireFact<number>;
  hostPromptCacheMiB?: WireFact<number>;
  servedModelAliases?: WireFact<string[]>;
};

/** The facts an inference capacity stores (Int columns cap the numbers). */
export type StoredEngineFacts = {
  engineKind: EngineKind | null;
  engineSlots: number | null;
  kvBudgetTokens: number | null;
  maxModelLen: number | null;
  engineFactsSource: EngineFactsSource;
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

/**
 * The capacity columns for one model's facts, or null when the CLI reported
 * none that a capacity stores.
 */
export function storedEngineFacts(facts: WireEngineFacts | undefined): StoredEngineFacts | null {
  if (!facts) return null;
  const stored = {
    engineKind: facts.engine ? engineKindToDb(facts.engine.value) : null,
    engineSlots: storedInt(facts.slots),
    kvBudgetTokens: storedInt(facts.kvTokens),
    maxModelLen: storedInt(facts.maxModelLen),
  };
  const sources = new Set(
    [facts.engine, facts.slots, facts.kvTokens, facts.maxModelLen]
      .filter((fact) => fact !== undefined)
      .map((fact) => fact.source),
  );
  if (sources.size === 0) return null;
  return {
    ...stored,
    engineFactsSource: sources.size > 1 ? "MIXED" : sources.has("config") ? "CONFIG" : "PROBE",
  };
}

export function sameStoredEngineFacts(left: StoredEngineFacts, right: StoredEngineFacts): boolean {
  return (
    left.engineKind === right.engineKind &&
    left.engineSlots === right.engineSlots &&
    left.kvBudgetTokens === right.kvBudgetTokens &&
    left.maxModelLen === right.maxModelLen &&
    left.engineFactsSource === right.engineFactsSource
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
 * capacity's L5 policy lock and the L2 locks of every target on it.
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

export function enginePreset(kind: EngineKind | null | undefined): EnginePreset {
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
}
