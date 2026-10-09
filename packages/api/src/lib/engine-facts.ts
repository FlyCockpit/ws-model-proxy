/**
 * Engine facts a node observes for a running instance (relay 3.0 `engineFacts`), and the
 * instance columns they fill. They are automatic limit sources only: the effective limit is
 * the version's override ?? the instance's observed fact ?? the built-in default
 * (`runtime-defaults.ts`), so a fact never overwrites a person's setting.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { type EngineWire, READER_SIGNALS, type ReaderSignal } from "./runtime-spec";

/** Prisma `EngineCountContext` values. */
export type EngineCountContext =
  | "UNSUPPORTED"
  | "VLLM_TOKENIZE"
  | "TGI_CHAT_TOKENIZE"
  | "LLAMA_APPLY_TEMPLATE"
  | "LLAMA_INPUT_TOKENS"
  | "READER_COUNT";

export const ENGINE_COUNT_CONTEXT_NAMES = [
  "unsupported",
  "vllm_tokenize",
  "tgi_chat_tokenize",
  "llama_apply_template",
  "llama_input_tokens",
  "reader_count",
] as const;
export type EngineCountContextName = (typeof ENGINE_COUNT_CONTEXT_NAMES)[number];

type WireFact<T> = { value: T; source: "probe" | "config" | "reader" };

/** The relay 3.0 `engineFacts` object (validated by the relay's strict frame schema). */
export type WireEngineFacts = {
  engine?: WireFact<EngineWire>;
  slots?: WireFact<number>;
  ctxPerSlot?: WireFact<number>;
  kvTokens?: WireFact<number>;
  maxModelLen?: WireFact<number>;
  hostPromptCacheMiB?: WireFact<number>;
  loadReader?: {
    value: { input: "route" | "command"; signals: ReaderSignal[] };
    source: "config";
  };
  countContext?: WireFact<EngineCountContextName>;
};

/** The `runtime_instance` fact columns. */
export type StoredInstanceFacts = {
  engineSlots: number | null;
  observedKvBudgetTokens: number | null;
  maxModelLen: number | null;
  countContext: EngineCountContext | null;
  loadSignals: ReaderSignal[];
};

const INT_COLUMN_MAX = 2 ** 31 - 1;

const COUNT_CONTEXT_TO_DB: Record<EngineCountContextName, EngineCountContext> = {
  unsupported: "UNSUPPORTED",
  vllm_tokenize: "VLLM_TOKENIZE",
  tgi_chat_tokenize: "TGI_CHAT_TOKENIZE",
  llama_apply_template: "LLAMA_APPLY_TEMPLATE",
  llama_input_tokens: "LLAMA_INPUT_TOKENS",
  reader_count: "READER_COUNT",
};

export function engineCountContextToDb(method: EngineCountContextName): EngineCountContext {
  return COUNT_CONTEXT_TO_DB[method];
}

/** True when the stored fact is a tokenize method the node can run. */
export function engineCountContextSupportsNative(
  method: EngineCountContext | null | undefined,
): boolean {
  return method != null && method !== "UNSUPPORTED";
}

/**
 * The defaults for engines that expose no parallel count: Ollama runs one request at a time
 * unless told otherwise, LM Studio four.
 */
export function engineDefaultConcurrency(engine: EngineWire | null | undefined): number | null {
  if (engine === "ollama") return 1;
  if (engine === "lm_studio") return 4;
  return null;
}

/** Runtime-level facts with each served model's facts layered on top. */
export function mergeEngineFacts(
  runtime: WireEngineFacts | undefined,
  model: WireEngineFacts | undefined,
): WireEngineFacts | undefined {
  if (!runtime && !model) return undefined;
  return { ...runtime, ...model };
}

function storedInt(fact: WireFact<number> | undefined): number | null {
  if (!fact || !Number.isInteger(fact.value) || fact.value < 1) return null;
  return Math.min(fact.value, INT_COLUMN_MAX);
}

const READER_SIGNAL_SET: ReadonlySet<string> = new Set(READER_SIGNALS);

/** The instance columns for one instance's facts, or null when none were reported. */
export function storedInstanceFacts(
  facts: WireEngineFacts | undefined,
): StoredInstanceFacts | null {
  if (!facts) return null;
  const stored: StoredInstanceFacts = {
    engineSlots: storedInt(facts.slots),
    observedKvBudgetTokens: storedInt(facts.kvTokens),
    maxModelLen: storedInt(facts.maxModelLen),
    countContext: facts.countContext ? engineCountContextToDb(facts.countContext.value) : null,
    loadSignals: (facts.loadReader?.value.signals ?? []).filter((signal) =>
      READER_SIGNAL_SET.has(signal),
    ),
  };
  const empty =
    stored.engineSlots === null &&
    stored.observedKvBudgetTokens === null &&
    stored.maxModelLen === null &&
    stored.countContext === null &&
    stored.loadSignals.length === 0;
  return empty ? null : stored;
}

export function sameStoredInstanceFacts(
  left: StoredInstanceFacts,
  right: StoredInstanceFacts,
): boolean {
  return (
    left.engineSlots === right.engineSlots &&
    left.observedKvBudgetTokens === right.observedKvBudgetTokens &&
    left.maxModelLen === right.maxModelLen &&
    left.countContext === right.countContext &&
    left.loadSignals.length === right.loadSignals.length &&
    left.loadSignals.every((signal, index) => signal === right.loadSignals[index])
  );
}

/**
 * Writes an instance's observed facts. The caller holds the `08:capacity:<instance>` fence
 * (`fences.capacity`, packages/db/src/capacity-lock-order.ts): admission reads them.
 */
export async function applyFactsToInstance(
  tx: Prisma.TransactionClient,
  input: { userId: string; instanceId: string; facts: StoredInstanceFacts; now: Date },
): Promise<void> {
  await tx.runtimeInstance.updateMany({
    where: { id: input.instanceId, userId: input.userId },
    data: { ...input.facts, factsAt: input.now },
  });
}

/** Display presets per engine. */
export type EnginePreset = {
  preset: "llama.cpp" | "vllm-sglang" | "ollama-lm-studio" | "generic";
  /** When an instance counts as FULL. */
  fullWhen:
    | "active_at_slots"
    | "user_cap_or_engine_load"
    | "active_at_user_parallel"
    | "active_at_user_cap";
  /** What warm-session protection counts. */
  protectionUnit: "slots" | "tokens";
};

export type EnginePresetOptions = {
  kvBudgetTokens?: number | null;
  /** The runtime has a metrics reader. */
  hasReader?: boolean;
};

export function enginePreset(
  engine: EngineWire | null | undefined,
  options?: EnginePresetOptions,
): EnginePreset {
  const preset = ((): EnginePreset => {
    switch (engine) {
      case "llama_cpp":
        return { preset: "llama.cpp", fullWhen: "active_at_slots", protectionUnit: "slots" };
      case "vllm":
      case "sglang":
        return {
          preset: "vllm-sglang",
          fullWhen: "user_cap_or_engine_load",
          protectionUnit: "tokens",
        };
      case "ollama":
      case "lm_studio":
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
    options?.hasReader === true && preset.fullWhen !== "user_cap_or_engine_load"
      ? { ...preset, fullWhen: "user_cap_or_engine_load" as const }
      : preset;
  if (
    engine !== "llama_cpp" &&
    options?.kvBudgetTokens != null &&
    Number.isInteger(options.kvBudgetTokens) &&
    options.kvBudgetTokens > 0
  ) {
    return { ...withLoad, protectionUnit: "tokens" };
  }
  return withLoad;
}
