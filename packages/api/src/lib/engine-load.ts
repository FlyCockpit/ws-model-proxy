/**
 * Live engine load as a FULL signal (S-D).
 *
 * The proxy's durable lease counts stay authoritative for traffic that goes
 * through it. A relay 2.7 `endpoint.load` reading adds two things leases
 * cannot see: load that bypasses the proxy (the owner calling llama.cpp
 * directly, another router on the box) and engine memory pressure (vLLM /
 * SGLang preemption). It can therefore only ADD to FULL, never relax it, and
 * a stale reading is ignored (fail open to lease counts).
 *
 * This module is pure and knows nothing about pools: it takes one member's
 * engine facts and its latest reading. The routing evaluator feeds it today;
 * the model-deployments engine-metrics phase can feed it per-instance load.
 *
 * | Engine              | FULL when (fresh reading)                              |
 * | llama.cpp           | slotsBusy >= slots, or deferred > 0                     |
 * | vLLM / SGLang       | waiting > 0 for >= 2 consecutive frames, or KV >= 0.95   |
 * | Ollama / LM Studio / generic | no engine signal                                |
 */
import { ENDPOINT_LOAD_STALE_AFTER_MS } from "./metric-routing";

/** Default KV usage fraction at which a vLLM/SGLang member counts as FULL. */
export const DEFAULT_KV_FULL_THRESHOLD = 0.95;
/** Consecutive accepted frames with `waiting > 0` that count as sustained. */
export const WAITING_SUSTAINED_FRAMES = 2;

export const ENGINE_KINDS = [
  "GENERIC",
  "LLAMA_CPP",
  "VLLM",
  "SGLANG",
  "OLLAMA",
  "LM_STUDIO",
] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export type EngineLoadMode = "AUTO" | "OFF";

export type EngineLoadState =
  | "off"
  | "none"
  | "stale"
  | "clear"
  | "full_waiting"
  | "full_kv"
  | "full_slots"
  | "full_deferred";

export const ENGINE_LOAD_STATES: readonly EngineLoadState[] = [
  "off",
  "none",
  "stale",
  "clear",
  "full_waiting",
  "full_kv",
  "full_slots",
  "full_deferred",
];

/** The engine facts and per-member override a verdict depends on. */
export type EngineLoadFacts = {
  engineKind: EngineKind | null;
  /** Concurrent sequences the engine reported (llama.cpp slots). */
  engineSlots: number | null;
  mode: EngineLoadMode;
  /** Per-member override; null = {@link DEFAULT_KV_FULL_THRESHOLD}. */
  kvFullThreshold: number | null;
};

/** One endpoint/model reading as the relay session keeps it. */
export type EngineLoadReading = {
  running: number;
  waiting: number;
  kvUsage?: number | undefined;
  slotsBusy?: number | undefined;
  deferred?: number | undefined;
  /** Consecutive accepted frames (fresh, no gap) with `waiting > 0`. */
  waitingStreak: number;
  receivedAt: Date;
};

export type EngineLoadVerdict = {
  state: EngineLoadState;
  full: boolean;
  /**
   * While `full`, when the verdict stops being trustworthy (the reading goes
   * stale). Null otherwise.
   */
  expiresAt: Date | null;
};

/** True when the engine kind emits a signal this module can act on. */
export function engineHasLoadSignal(kind: EngineKind | null): boolean {
  return kind === "LLAMA_CPP" || kind === "VLLM" || kind === "SGLANG";
}

/** A usable KV threshold, else the default. */
export function effectiveKvFullThreshold(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : DEFAULT_KV_FULL_THRESHOLD;
}

export function evaluateEngineLoad(
  facts: EngineLoadFacts,
  reading: EngineLoadReading | null,
  now: Date,
): EngineLoadVerdict {
  if (facts.mode === "OFF") return { state: "off", full: false, expiresAt: null };
  if (!engineHasLoadSignal(facts.engineKind)) {
    return { state: "none", full: false, expiresAt: null };
  }
  if (!reading) return { state: "stale", full: false, expiresAt: null };
  const ageMs = Math.max(0, now.getTime() - reading.receivedAt.getTime());
  if (ageMs > ENDPOINT_LOAD_STALE_AFTER_MS) {
    return { state: "stale", full: false, expiresAt: null };
  }
  const expiresAt = new Date(reading.receivedAt.getTime() + ENDPOINT_LOAD_STALE_AFTER_MS);
  const full = (state: EngineLoadState): EngineLoadVerdict => ({ state, full: true, expiresAt });
  if (facts.engineKind === "LLAMA_CPP") {
    if (
      facts.engineSlots !== null &&
      facts.engineSlots > 0 &&
      reading.slotsBusy !== undefined &&
      reading.slotsBusy >= facts.engineSlots
    ) {
      return full("full_slots");
    }
    if (reading.deferred !== undefined && reading.deferred > 0) return full("full_deferred");
    return { state: "clear", full: false, expiresAt: null };
  }
  // vLLM / SGLang.
  if (reading.waiting > 0 && reading.waitingStreak >= WAITING_SUSTAINED_FRAMES) {
    return full("full_waiting");
  }
  if (
    reading.kvUsage !== undefined &&
    reading.kvUsage >= effectiveKvFullThreshold(facts.kvFullThreshold)
  ) {
    return full("full_kv");
  }
  return { state: "clear", full: false, expiresAt: null };
}

export function engineKindFromDb(value: string | null | undefined): EngineKind | null {
  return (ENGINE_KINDS as readonly string[]).includes(value ?? "") ? (value as EngineKind) : null;
}
