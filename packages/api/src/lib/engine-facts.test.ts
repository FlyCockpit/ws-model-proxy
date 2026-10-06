import { describe, expect, it } from "vitest";
import {
  engineCountContextSupportsNative,
  engineDefaultConcurrency,
  enginePreset,
  mergeEngineFacts,
  sameStoredInstanceFacts,
  storedInstanceFacts,
} from "./engine-facts";

describe("engine facts", () => {
  it("layers model facts over runtime facts", () => {
    expect(
      mergeEngineFacts(
        { slots: { value: 4, source: "probe" }, maxModelLen: { value: 8192, source: "probe" } },
        { slots: { value: 2, source: "config" } },
      ),
    ).toEqual({
      slots: { value: 2, source: "config" },
      maxModelLen: { value: 8192, source: "probe" },
    });
    expect(mergeEngineFacts(undefined, undefined)).toBeUndefined();
  });

  it("maps facts to the instance columns", () => {
    expect(
      storedInstanceFacts({
        engine: { value: "vllm", source: "probe" },
        slots: { value: 8, source: "probe" },
        kvTokens: { value: 120_000, source: "probe" },
        maxModelLen: { value: 2 ** 40, source: "probe" },
        countContext: { value: "vllm_tokenize", source: "probe" },
        loadReader: {
          value: { input: "route", signals: ["running", "waiting"] },
          source: "config",
        },
      }),
    ).toEqual({
      engineSlots: 8,
      observedKvBudgetTokens: 120_000,
      maxModelLen: 2 ** 31 - 1,
      countContext: "VLLM_TOKENIZE",
      loadSignals: ["running", "waiting"],
    });
  });

  it("stores nothing when no instance column is reported", () => {
    expect(storedInstanceFacts(undefined)).toBeNull();
    expect(storedInstanceFacts({ engine: { value: "vllm", source: "probe" } })).toBeNull();
    expect(storedInstanceFacts({ slots: { value: 0, source: "probe" } })).toBeNull();
  });

  it("gates native count on a probed tokenize method", () => {
    expect(engineCountContextSupportsNative("VLLM_TOKENIZE")).toBe(true);
    expect(engineCountContextSupportsNative("UNSUPPORTED")).toBe(false);
    expect(engineCountContextSupportsNative(null)).toBe(false);
  });

  it("compares stored facts field by field", () => {
    const facts = {
      engineSlots: 4,
      observedKvBudgetTokens: null,
      maxModelLen: 4096,
      countContext: null,
      loadSignals: ["running" as const],
    };
    expect(sameStoredInstanceFacts(facts, { ...facts })).toBe(true);
    expect(sameStoredInstanceFacts(facts, { ...facts, loadSignals: [] })).toBe(false);
    expect(sameStoredInstanceFacts(facts, { ...facts, engineSlots: 5 })).toBe(false);
  });

  it("uses the Ollama and LM Studio defaults only for those engines", () => {
    expect(engineDefaultConcurrency("ollama")).toBe(1);
    expect(engineDefaultConcurrency("lm_studio")).toBe(4);
    expect(engineDefaultConcurrency("vllm")).toBeNull();
    expect(engineDefaultConcurrency(null)).toBeNull();
  });

  it("derives a display preset from the engine", () => {
    expect(enginePreset("llama_cpp").preset).toBe("llama.cpp");
    expect(enginePreset("sglang").fullWhen).toBe("user_cap_or_engine_load");
    expect(enginePreset("lm_studio").fullWhen).toBe("active_at_user_parallel");
    expect(enginePreset("other").preset).toBe("generic");
  });

  it("switches to token mode when the KV budget is known, except for llama.cpp", () => {
    expect(enginePreset("other", { kvBudgetTokens: 1000 }).protectionUnit).toBe("tokens");
    expect(enginePreset("llama_cpp", { kvBudgetTokens: 1000 }).protectionUnit).toBe("slots");
  });

  it("gates on engine load when the runtime has a metrics reader", () => {
    expect(enginePreset("other", { hasReader: true }).fullWhen).toBe("user_cap_or_engine_load");
  });
});
