import { describe, expect, it } from "vitest";
import {
  engineDefaultConcurrency,
  enginePreset,
  isHardLimitRefreshAdmissible,
  mergeEngineFacts,
  sameStoredEngineFacts,
  storedEngineFacts,
} from "./engine-facts";

describe("engine facts", () => {
  it("layers model facts over endpoint facts", () => {
    expect(
      mergeEngineFacts(
        {
          engine: { value: "vllm", source: "probe" },
          maxModelLen: { value: 8_192, source: "probe" },
        },
        { maxModelLen: { value: 131_072, source: "probe" } },
      ),
    ).toEqual({
      engine: { value: "vllm", source: "probe" },
      maxModelLen: { value: 131_072, source: "probe" },
    });
    expect(mergeEngineFacts(undefined, undefined)).toBeUndefined();
  });

  it("maps facts to capacity columns with one combined source", () => {
    expect(
      storedEngineFacts({
        engine: { value: "llama.cpp", source: "config" },
        slots: { value: 4, source: "probe" },
        ctxPerSlot: { value: 32_768, source: "probe" },
      }),
    ).toEqual({
      engineKind: "LLAMA_CPP",
      engineSlots: 4,
      kvBudgetTokens: null,
      maxModelLen: null,
      engineFactsSource: "MIXED",
    });
    expect(
      storedEngineFacts({
        engine: { value: "sglang", source: "probe" },
        kvTokens: { value: 5_000_000_000, source: "probe" },
      }),
    ).toMatchObject({ kvBudgetTokens: 2 ** 31 - 1, engineFactsSource: "PROBE" });
    expect(storedEngineFacts({ slots: { value: 2, source: "config" } })).toMatchObject({
      engineKind: null,
      engineSlots: 2,
      engineFactsSource: "CONFIG",
    });
    // Aliases and per-slot context are not capacity columns.
    expect(
      storedEngineFacts({ servedModelAliases: { value: ["a", "b"], source: "probe" } }),
    ).toBeNull();
    expect(storedEngineFacts(undefined)).toBeNull();
  });

  it("compares stored facts field by field", () => {
    const facts = storedEngineFacts({ slots: { value: 2, source: "probe" } });
    const other = storedEngineFacts({ slots: { value: 3, source: "probe" } });
    if (!facts || !other) throw new Error("facts");
    expect(sameStoredEngineFacts(facts, { ...facts })).toBe(true);
    expect(sameStoredEngineFacts(facts, other)).toBe(false);
  });

  it("uses the Ollama and LM Studio defaults only for those engines", () => {
    expect(engineDefaultConcurrency("ollama")).toBe(1);
    expect(engineDefaultConcurrency("lm-studio")).toBe(4);
    expect(engineDefaultConcurrency("vllm")).toBeNull();
    expect(engineDefaultConcurrency(undefined)).toBeNull();
  });

  it("admits a refreshed limit only when every policy on the capacity still fits", () => {
    expect(isHardLimitRefreshAdmissible(4, [])).toBe(true);
    expect(
      isHardLimitRefreshAdmissible(4, [
        { kind: "direct", concurrencyLimit: 4, reservedSlots: 1 },
        {
          kind: "member",
          mode: "INHERIT",
          limit: null,
          reserved: null,
          poolLimit: 3,
          poolReserved: 2,
        },
      ]),
    ).toBe(true);
    expect(
      isHardLimitRefreshAdmissible(4, [{ kind: "direct", concurrencyLimit: 5, reservedSlots: 0 }]),
    ).toBe(false);
    expect(
      isHardLimitRefreshAdmissible(4, [
        {
          kind: "member",
          mode: "LIMITED",
          limit: 6,
          reserved: 0,
          poolLimit: null,
          poolReserved: 0,
        },
      ]),
    ).toBe(false);
    expect(
      isHardLimitRefreshAdmissible(2, [
        {
          kind: "member",
          mode: "INHERIT",
          limit: null,
          reserved: null,
          poolLimit: null,
          poolReserved: 3,
        },
      ]),
    ).toBe(false);
    expect(isHardLimitRefreshAdmissible(0, [])).toBe(false);
    expect(isHardLimitRefreshAdmissible(10_001, [])).toBe(false);
  });

  it("derives a display preset from the engine kind", () => {
    expect(enginePreset("LLAMA_CPP")).toEqual({
      preset: "llama.cpp",
      fullWhen: "active_at_slots",
      protectionUnit: "slots",
    });
    expect(enginePreset("VLLM").protectionUnit).toBe("tokens");
    expect(enginePreset("SGLANG").preset).toBe("vllm-sglang");
    expect(enginePreset("OLLAMA").preset).toBe("ollama-lm-studio");
    expect(enginePreset(null).preset).toBe("generic");
  });
});
