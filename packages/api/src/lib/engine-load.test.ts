import { describe, expect, it } from "vitest";

import {
  DEFAULT_KV_FULL_THRESHOLD,
  type EngineLoadFacts,
  type EngineLoadReading,
  effectiveKvFullThreshold,
  engineKindFromDb,
  evaluateEngineLoad,
} from "./engine-load";
import { ENDPOINT_LOAD_STALE_AFTER_MS } from "./metric-routing";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function facts(overrides: Partial<EngineLoadFacts> = {}): EngineLoadFacts {
  return {
    engineKind: "VLLM",
    engineSlots: null,
    mode: "AUTO",
    kvFullThreshold: null,
    ...overrides,
  };
}

function reading(overrides: Partial<EngineLoadReading> = {}): EngineLoadReading {
  return { running: 4, waiting: 0, waitingStreak: 0, receivedAt: NOW, ...overrides };
}

describe("evaluateEngineLoad", () => {
  const cases: Array<{
    name: string;
    facts: Partial<EngineLoadFacts>;
    reading: Partial<EngineLoadReading> | null;
    now?: Date;
    state: string;
    full: boolean;
  }> = [
    // vLLM / SGLang
    {
      name: "vllm waiting once is not sustained",
      facts: {},
      reading: { waiting: 3, waitingStreak: 1 },
      state: "clear",
      full: false,
    },
    {
      name: "vllm waiting for two frames is FULL",
      facts: {},
      reading: { waiting: 3, waitingStreak: 2 },
      state: "full_waiting",
      full: true,
    },
    {
      name: "sglang waiting for two frames is FULL",
      facts: { engineKind: "SGLANG" },
      reading: { waiting: 1, waitingStreak: 5 },
      state: "full_waiting",
      full: true,
    },
    {
      name: "a streak with waiting 0 now is not FULL",
      facts: {},
      reading: { waiting: 0, waitingStreak: 3 },
      state: "clear",
      full: false,
    },
    {
      name: "kv at the default threshold is FULL",
      facts: {},
      reading: { kvUsage: 0.95 },
      state: "full_kv",
      full: true,
    },
    {
      name: "kv just under the default is clear",
      facts: {},
      reading: { kvUsage: 0.949 },
      state: "clear",
      full: false,
    },
    {
      name: "kv override lowers the threshold",
      facts: { kvFullThreshold: 0.8 },
      reading: { kvUsage: 0.85 },
      state: "full_kv",
      full: true,
    },
    {
      name: "kv override raises the threshold",
      facts: { kvFullThreshold: 1 },
      reading: { kvUsage: 0.99 },
      state: "clear",
      full: false,
    },
    {
      name: "an invalid kv override falls back to the default",
      facts: { kvFullThreshold: 0 },
      reading: { kvUsage: 0.96 },
      state: "full_kv",
      full: true,
    },
    {
      name: "vllm ignores slotsBusy and deferred",
      facts: { engineSlots: 1 },
      reading: { slotsBusy: 9, deferred: 9 },
      state: "clear",
      full: false,
    },
    // llama.cpp
    {
      name: "llama busy slots at total is FULL",
      facts: { engineKind: "LLAMA_CPP", engineSlots: 4 },
      reading: { slotsBusy: 4 },
      state: "full_slots",
      full: true,
    },
    {
      name: "llama busy slots below total is clear",
      facts: { engineKind: "LLAMA_CPP", engineSlots: 4 },
      reading: { slotsBusy: 3 },
      state: "clear",
      full: false,
    },
    {
      name: "llama deferred > 0 is FULL",
      facts: { engineKind: "LLAMA_CPP", engineSlots: 4 },
      reading: { slotsBusy: 1, deferred: 1 },
      state: "full_deferred",
      full: true,
    },
    {
      name: "llama without known slots ignores slotsBusy",
      facts: { engineKind: "LLAMA_CPP", engineSlots: null },
      reading: { slotsBusy: 8 },
      state: "clear",
      full: false,
    },
    {
      name: "llama ignores waiting streaks and kv",
      facts: { engineKind: "LLAMA_CPP", engineSlots: 4 },
      reading: { waiting: 9, waitingStreak: 9, kvUsage: 1 },
      state: "clear",
      full: false,
    },
    // No signal
    {
      name: "ollama has no signal",
      facts: { engineKind: "OLLAMA" },
      reading: { waiting: 9, waitingStreak: 9, kvUsage: 1 },
      state: "none",
      full: false,
    },
    {
      name: "lm studio has no signal",
      facts: { engineKind: "LM_STUDIO" },
      reading: { waiting: 9, waitingStreak: 9 },
      state: "none",
      full: false,
    },
    {
      name: "generic has no signal",
      facts: { engineKind: "GENERIC" },
      reading: { waiting: 9, waitingStreak: 9 },
      state: "none",
      full: false,
    },
    {
      name: "unknown engine has no signal",
      facts: { engineKind: null },
      reading: { waiting: 9, waitingStreak: 9 },
      state: "none",
      full: false,
    },
    // Override
    {
      name: "override off ignores a FULL reading",
      facts: { mode: "OFF" },
      reading: { waiting: 9, waitingStreak: 9, kvUsage: 1 },
      state: "off",
      full: false,
    },
    // Freshness
    { name: "no reading is stale", facts: {}, reading: null, state: "stale", full: false },
    {
      name: "a reading past the staleness window is ignored",
      facts: {},
      reading: {
        waiting: 9,
        waitingStreak: 9,
        receivedAt: new Date(NOW.getTime() - ENDPOINT_LOAD_STALE_AFTER_MS - 1),
      },
      state: "stale",
      full: false,
    },
    {
      name: "a reading exactly at the window is still fresh",
      facts: {},
      reading: {
        waiting: 9,
        waitingStreak: 9,
        receivedAt: new Date(NOW.getTime() - ENDPOINT_LOAD_STALE_AFTER_MS),
      },
      state: "full_waiting",
      full: true,
    },
  ];
  it.each(cases)("$name", (testCase) => {
    const verdict = evaluateEngineLoad(
      facts(testCase.facts),
      testCase.reading ? reading(testCase.reading) : null,
      testCase.now ?? NOW,
    );
    expect(verdict.state).toBe(testCase.state);
    expect(verdict.full).toBe(testCase.full);
    // A FULL verdict always carries an expiry no later than the staleness window.
    if (testCase.full) {
      expect(verdict.expiresAt).not.toBeNull();
      expect(verdict.expiresAt!.getTime()).toBeLessThanOrEqual(
        NOW.getTime() + ENDPOINT_LOAD_STALE_AFTER_MS,
      );
      expect(verdict.expiresAt!.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    } else {
      expect(verdict.expiresAt).toBeNull();
    }
  });

  it("expires a FULL verdict when its reading goes stale", () => {
    const receivedAt = new Date(NOW.getTime() - 4_000);
    const verdict = evaluateEngineLoad(
      facts(),
      reading({ waiting: 2, waitingStreak: 2, receivedAt }),
      NOW,
    );
    expect(verdict.expiresAt).toEqual(
      new Date(receivedAt.getTime() + ENDPOINT_LOAD_STALE_AFTER_MS),
    );
  });
});

describe("helpers", () => {
  it("validates the kv threshold and the engine kind", () => {
    expect(effectiveKvFullThreshold(null)).toBe(DEFAULT_KV_FULL_THRESHOLD);
    expect(effectiveKvFullThreshold(0.5)).toBe(0.5);
    expect(effectiveKvFullThreshold(1.2)).toBe(DEFAULT_KV_FULL_THRESHOLD);
    expect(effectiveKvFullThreshold(Number.NaN)).toBe(DEFAULT_KV_FULL_THRESHOLD);
    expect(engineKindFromDb("VLLM")).toBe("VLLM");
    expect(engineKindFromDb("nope")).toBeNull();
    expect(engineKindFromDb(null)).toBeNull();
  });
});
