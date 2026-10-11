import { engineDefaultConcurrency } from "@ws-model-proxy/api/lib/engine-facts";
import type { EngineWire } from "@ws-model-proxy/api/lib/runtime-spec";

/** Prisma `Engine` values (upper case) to the wire vocabulary. */
const ENGINE_WIRE: Record<string, EngineWire> = {
  VLLM: "vllm",
  SGLANG: "sglang",
  LLAMA_CPP: "llama_cpp",
  OLLAMA: "ollama",
  LM_STUDIO: "lm_studio",
  OTHER: "other",
};

/**
 * An instance's physical concurrency limit (capacityId = instance): the version's override,
 * else the slots the node observed, else the engine's built-in default; null = unlimited
 * (`runtime-defaults.ts`: `concurrencyLimit` is automatic from the engine). A service runtime
 * (no engine) has no limit of its own.
 */
export function effectiveInstanceConcurrency(input: {
  override: number | null;
  engineSlots: number | null;
  engine: string | null;
}): number | null {
  if (input.override !== null) return input.override;
  if (input.engineSlots !== null) return input.engineSlots;
  const engine = input.engine === null ? undefined : ENGINE_WIRE[input.engine];
  return engineDefaultConcurrency(engine);
}
