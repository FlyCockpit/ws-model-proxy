import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({ isDbShutdownFenceArmed: () => false }));

import {
  createKvEvictionFeedback,
  EVICTION_MISS_FRACTION,
  KV_EVICTION_FLUSH_MIN_INTERVAL_MS,
  MAX_PENDING_CAPACITIES,
  qualifiesAsEvictionEvidence,
} from "./kv-eviction-feedback.js";

const now = new Date("2026-09-30T12:00:00Z");
const valid: Parameters<typeof qualifiesAsEvictionEvidence>[0] = {
  policy: {
    enabled: true,
    windowSeconds: 300,
    minTokens: 8000,
    share: "FIRST_COME",
    fixedPercent: null,
  },
  engineKind: "VLLM",
  kvBudgetTokens: 100_000,
  ok: true,
  usage: { promptTokens: 9000, cacheReadTokens: 0 },
  evidence: { tokens: 8000, lastUsedAt: now.getTime(), confirmed: true },
  now,
};

describe("eviction evidence", () => {
  it("pins evidence and buffering constants", () => {
    expect([
      EVICTION_MISS_FRACTION,
      KV_EVICTION_FLUSH_MIN_INTERVAL_MS,
      MAX_PENDING_CAPACITIES,
    ]).toEqual([0.05, 1000, 1024]);
  });
  it.each([
    { name: "qualifying miss", patch: {}, expected: true },
    {
      name: "disabled protection",
      patch: { policy: { ...valid.policy, enabled: false } },
      expected: false,
    },
    { name: "llama.cpp", patch: { engineKind: "LLAMA_CPP" as const }, expected: false },
    ...[null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((kvBudgetTokens) => ({
      name: `slot mode ${kvBudgetTokens}`,
      patch: { kvBudgetTokens },
      expected: false,
    })),
    { name: "failed terminal", patch: { ok: false }, expected: false },
    {
      name: "unknown cache",
      patch: { usage: { ...valid.usage, cacheReadTokens: null } },
      expected: false,
    },
    {
      name: "unknown prompt",
      patch: { usage: { ...valid.usage, promptTokens: null } },
      expected: false,
    },
    {
      name: "small actual prompt",
      patch: { usage: { ...valid.usage, promptTokens: 7999 } },
      expected: false,
    },
    {
      name: "prompt boundary",
      patch: { usage: { ...valid.usage, promptTokens: 8000 } },
      expected: true,
    },
    { name: "non-affinity", patch: { evidence: undefined }, expected: false },
    {
      name: "short prefix",
      patch: { evidence: { ...valid.evidence!, tokens: 7999 } },
      expected: false,
    },
    {
      name: "unconfirmed",
      patch: { evidence: { ...valid.evidence!, confirmed: false } },
      expected: false,
    },
    {
      name: "stale",
      patch: { evidence: { ...valid.evidence!, lastUsedAt: now.getTime() - 300001 } },
      expected: false,
    },
    {
      name: "age boundary",
      patch: { evidence: { ...valid.evidence!, lastUsedAt: now.getTime() - 300000 } },
      expected: true,
    },
    {
      name: "5% boundary",
      patch: { usage: { ...valid.usage, cacheReadTokens: 400 } },
      expected: true,
    },
    {
      name: "above 5%",
      patch: { usage: { ...valid.usage, cacheReadTokens: 401 } },
      expected: false,
    },
    {
      name: "partial hit",
      patch: { usage: { ...valid.usage, cacheReadTokens: 4000 } },
      expected: false,
    },
    { name: "hit", patch: { usage: { ...valid.usage, cacheReadTokens: 8000 } }, expected: false },
    {
      name: "invalid cache",
      patch: { usage: { ...valid.usage, cacheReadTokens: -1 } },
      expected: false,
    },
    {
      name: "NaN cache",
      patch: { usage: { ...valid.usage, cacheReadTokens: Number.NaN } },
      expected: false,
    },
  ])("$name", ({ patch, expected }) =>
    expect(qualifiesAsEvictionEvidence({ ...valid, ...patch })).toBe(expected),
  );
});

describe("buffered recorder", () => {
  const recorders: ReturnType<typeof createKvEvictionFeedback>[] = [];
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const write = vi.fn(async () => {});
    const log = vi.fn();
    let fenced = false;
    const recorder = createKvEvictionFeedback({
      clock: Date.now,
      write,
      log,
      shutdown: () => fenced,
    });
    recorders.push(recorder);
    return {
      ...recorder,
      write,
      log,
      fence: () => {
        fenced = true;
      },
    };
  }
  afterEach(() => {
    for (const recorder of recorders.splice(0)) recorder.stop();
    vi.useRealTimers();
  });
  it("first observation flushes immediately; inside a second only one trailing flush", async () => {
    const r = setup();
    r.observe("c", "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(r.write).toHaveBeenLastCalledWith({ capacityId: "c", ownerId: "o", count: 1, now });
    for (let i = 0; i < 7; i++) r.observe("c", "o");
    await vi.advanceTimersByTimeAsync(999);
    expect(r.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.write).toHaveBeenCalledTimes(2);
    expect(r.write).toHaveBeenLastCalledWith(expect.objectContaining({ count: 7 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores an observation naming a different owner for a pending capacity", async () => {
    const r = setup();
    r.observe("c", "o");
    await vi.advanceTimersByTimeAsync(0);
    r.observe("c", "intruder");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(r.write).not.toHaveBeenCalledWith(expect.objectContaining({ ownerId: "intruder" }));
  });
  it("an observation after an idle second flushes immediately again", async () => {
    const r = setup();
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(2);
  });
  it("a synchronously throwing writer is swallowed without an unhandled rejection", async () => {
    const r = setup();
    r.write.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(2);
  });
  it("clamps trailing counts and keeps capacities independent", async () => {
    const r = setup();
    r.observe("a", "o");
    r.observe("b", "o");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) r.observe("a", "o");
    r.observe("b", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(4);
    expect(r.write).toHaveBeenCalledWith(expect.objectContaining({ capacityId: "a", count: 10 }));
    expect(r.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityId: "b", count: 1 }),
    );
  });
  it("drops failed flushes, throttles logging, and keeps working without rejections", async () => {
    const r = setup();
    r.write.mockRejectedValueOnce(new Error("failed"));
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.write.mockRejectedValueOnce(new Error("failed"));
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(3);
  });
  it("delayed failures that settle together still log at most once per minute", async () => {
    const r = setup();
    const rejectWrites: Array<(error: Error) => void> = [];
    r.write.mockImplementation(
      () => new Promise<void>((_resolve, reject) => rejectWrites.push(reject)),
    );
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(60_000);
    r.observe("b", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(rejectWrites).toHaveLength(2);
    for (const reject of rejectWrites) reject(new Error("delayed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
  });
  it("bounds new keys; idle entries leave room again", async () => {
    const r = setup();
    for (let i = 0; i < MAX_PENDING_CAPACITIES + 1; i++) r.observe(`c${i}`, "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1024);
    await vi.advanceTimersByTimeAsync(1000);
    r.observe("new", "o");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1025);
  });
  it.each(["stop", "fence"] as const)("%s clears timers and prevents writes", async (action) => {
    const r = setup();
    r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(0);
    r.observe("a", "o");
    r[action]();
    await vi.advanceTimersByTimeAsync(1000);
    r.observe("b", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fence between observe and microtask prevents the first write", async () => {
    const r = setup();
    r.observe("a", "o");
    r.fence();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hits leave K untouched without any writer call", async () => {
    const r = setup();
    if (qualifiesAsEvictionEvidence({ ...valid, usage: { ...valid.usage, cacheReadTokens: 8000 } }))
      r.observe("a", "o");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).not.toHaveBeenCalled();
  });
});
