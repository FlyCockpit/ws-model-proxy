import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  default: {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));
// No database in unit tests: the real env module would demand DATABASE_URL.
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({ isDbShutdownFenceArmed: () => false }));
vi.mock("./cache-affinity-generation.js", () => ({
  resetAffinityForCapacities: vi.fn(async () => undefined),
}));

import {
  createKvEvictionFeedback,
  createKvEvictionResetLedger,
  EVICTION_MISS_FRACTION,
  KV_EVICTION_FLUSH_MIN_INTERVAL_MS,
  MAX_PENDING_CAPACITIES,
  MAX_RESET_CAPACITIES,
  qualifiesAsEvictionEvidence,
  recordKvEvictionObservations,
  resetKvEvictionForEndpoint,
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
    {
      name: "frozen eviction feedback",
      patch: { policy: { ...valid.policy, evictionFeedbackEnabled: false } },
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
      name: "5% boundary of prompt",
      patch: { usage: { ...valid.usage, cacheReadTokens: 450 } },
      expected: true,
    },
    {
      name: "above 5% of prompt",
      patch: { usage: { ...valid.usage, cacheReadTokens: 451 } },
      expected: false,
    },
    {
      name: "stale vs restart reset",
      patch: { resetAtMs: now.getTime() + 1 },
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

  it("a 12k reported prefix with an 18k estimate and 700 cached tokens is a hit on prompt", () => {
    const usage = { promptTokens: 12_000, cacheReadTokens: 700 };
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        usage,
        evidence: { ...valid.evidence!, tokens: 12_000 },
      }),
    ).toBe(false);
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        usage,
        evidence: { ...valid.evidence!, tokens: 18_000 },
      }),
    ).toBe(false);
  });

  it("endpoint reset deletes only matching capacity rows", async () => {
    const findMany = vi.fn(async () => [{ id: "c1" }, { id: "c2" }]);
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const db = {
      inferenceCapacity: { findMany },
      capacityKvEviction: { deleteMany },
    } as unknown as NonNullable<Parameters<typeof resetKvEvictionForEndpoint>[3]>;
    await resetKvEvictionForEndpoint("device", "vllm", now, db);
    expect(deleteMany).toHaveBeenCalledWith({ where: { capacityId: { in: ["c1", "c2"] } } });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        ExecutionTargets: {
          some: { DiscoveredModel: { Endpoint: { cliDeviceId: "device", slug: "vllm" } } },
        },
      },
      select: { id: true },
    });
  });

  it("freeze holds K: misses are not evidence until unfrozen", () => {
    const frozen = { ...valid, policy: { ...valid.policy, evictionFeedbackEnabled: false } };
    expect(qualifiesAsEvictionEvidence(frozen)).toBe(false);
    expect(
      qualifiesAsEvictionEvidence({ ...frozen, policy: { ...valid.policy, enabled: false } }),
    ).toBe(false);
    expect(
      qualifiesAsEvictionEvidence({
        ...frozen,
        policy: { ...valid.policy, evictionFeedbackEnabled: true },
      }),
    ).toBe(true);
  });

  it("reasoning follow-up with large C is not evidence when cache read covers P", () => {
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        usage: { promptTokens: 9_000, cacheReadTokens: 9_000 },
        evidence: { ...valid.evidence!, tokens: 209_000 },
      }),
    ).toBe(false);
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        usage: { promptTokens: 9_000, cacheReadTokens: 0 },
        evidence: { ...valid.evidence!, tokens: 209_000 },
      }),
    ).toBe(true);
  });

  it("never treats kvOccupancy as eviction evidence", () => {
    const source = readFileSync(new URL("./kv-eviction-feedback.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/kvOccupancy|occupancy/);
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        usage: { promptTokens: 12_000, cacheReadTokens: 0 },
      }),
    ).toBe(true);
  });
});

function fakeDb() {
  const $executeRaw = vi.fn(async () => 1);
  return {
    $executeRaw,
    client: { $executeRaw } as unknown as NonNullable<
      Parameters<typeof recordKvEvictionObservations>[1]
    >,
  };
}

describe("recordKvEvictionObservations input bounds", () => {
  it.each([
    { name: "empty capacity id", capacityId: "", ownerId: "o", at: now },
    { name: "129-character capacity id", capacityId: "c".repeat(129), ownerId: "o", at: now },
    { name: "empty owner", capacityId: "c", ownerId: "", at: now },
    { name: "invalid time", capacityId: "c", ownerId: "o", at: new Date(Number.NaN) },
  ])("$name writes nothing", async ({ capacityId, ownerId, at }) => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId, ownerId, sessionIds: ["s"], now: at },
      db.client,
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("a 128-character capacity id is written", async () => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId: "c".repeat(128), ownerId: "o", sessionIds: ["s"], now },
      db.client,
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it("empty session ids write nothing", async () => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId: "c", ownerId: "o", sessionIds: [], now },
      db.client,
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("blank or oversized session ids write nothing", async () => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId: "c", ownerId: "o", sessionIds: ["", "s".repeat(129)], now },
      db.client,
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("each distinct session is one upsert", async () => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId: "c", ownerId: "o", sessionIds: ["a", "b", "a"], now },
      db.client,
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });
  it("a 128-character session id is written", async () => {
    const db = fakeDb();
    await recordKvEvictionObservations(
      { capacityId: "c", ownerId: "o", sessionIds: ["s".repeat(128)], now },
      db.client,
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
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
    r.observe("c", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(r.write).toHaveBeenLastCalledWith({
      capacityId: "c",
      ownerId: "o",
      sessionIds: ["s"],
      now,
      kind: "miss",
    });
    for (let i = 0; i < 7; i++) r.observe("c", "o", `t${i}`);
    await vi.advanceTimersByTimeAsync(999);
    expect(r.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.write).toHaveBeenCalledTimes(8);
    expect(r.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionIds: ["t6"], kind: "miss" }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces the same session in the buffer", async () => {
    const r = setup();
    r.observe("c", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 7; i++) r.observe("c", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(2);
    expect(r.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionIds: ["s"] }));
  });
  it("ignores an observation naming a different owner for a pending capacity", async () => {
    const r = setup();
    r.observe("c", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    r.observe("c", "intruder", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(r.write).not.toHaveBeenCalledWith(expect.objectContaining({ ownerId: "intruder" }));
  });
  it("skips blank or oversized session ids", async () => {
    const r = setup();
    r.observe("c", "o", "");
    r.observe("c", "o", "s".repeat(129));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).not.toHaveBeenCalled();
  });
  it("an observation after an idle second flushes immediately again", async () => {
    const r = setup();
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(2);
  });
  it("a synchronously throwing writer is swallowed without an unhandled rejection", async () => {
    const r = setup();
    r.write.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(2);
  });
  it("clamps trailing sessions and keeps capacities independent", async () => {
    const r = setup();
    r.observe("a", "o", "s");
    r.observe("b", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) r.observe("a", "o", `s${i}`);
    r.observe("b", "o", "t");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(13);
    expect(r.write).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityId: "a",
        sessionIds: ["s9"],
        kind: "miss",
      }),
    );
    expect(r.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityId: "b", sessionIds: ["t"] }),
    );
  });
  it("drops failed flushes, throttles logging, and keeps working without rejections", async () => {
    const r = setup();
    r.write.mockRejectedValueOnce(new Error("failed"));
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.write.mockRejectedValueOnce(new Error("failed"));
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.log).toHaveBeenCalledTimes(1);
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(3);
  });
  it("holds one in-flight writer for the same capacity and recovers with one bounded trailing flush", async () => {
    const r = setup();
    let settle: (() => void) | undefined;
    r.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 100; i++) r.observe("a", "o", `s${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(r.write).toHaveBeenCalledTimes(1);
    settle!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(11);
    expect(r.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capacityId: "a",
        sessionIds: ["s9"],
        kind: "miss",
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(11);
    expect(vi.getTimerCount()).toBe(0);
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(12);
    expect(r.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionIds: ["s"] }));
  });
  it("delayed failures that settle together still log at most once per minute", async () => {
    const r = setup();
    const rejectWrites: Array<(error: Error) => void> = [];
    r.write.mockImplementation(
      () => new Promise<void>((_resolve, reject) => rejectWrites.push(reject)),
    );
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(60_000);
    r.observe("b", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(rejectWrites).toHaveLength(2);
    for (const reject of rejectWrites) reject(new Error("delayed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toHaveBeenCalledTimes(1);
  });
  it("bounds new keys; idle entries leave room again", async () => {
    const r = setup();
    for (let i = 0; i < MAX_PENDING_CAPACITIES + 1; i++) r.observe(`c${i}`, "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1024);
    await vi.advanceTimersByTimeAsync(1000);
    r.observe("new", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledTimes(1025);
  });
  it.each(["stop", "fence"] as const)("%s clears timers and prevents writes", async (action) => {
    const r = setup();
    r.observe("a", "o", "s");
    await vi.advanceTimersByTimeAsync(0);
    r.observe("a", "o", "s");
    r[action]();
    await vi.advanceTimersByTimeAsync(1000);
    r.observe("b", "o", "s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fence between observe and microtask prevents the first write", async () => {
    const r = setup();
    r.observe("a", "o", "s");
    r.fence();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hits flush as continuations without counting as misses", async () => {
    const r = setup();
    expect(
      qualifiesAsEvictionEvidence({ ...valid, usage: { ...valid.usage, cacheReadTokens: 8000 } }),
    ).toBe(false);
    r.observe("a", "o", "s", "hit");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.write).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ["s"], kind: "hit" }),
    );
  });
});

describe("bounded reset generations", () => {
  it("never revives a long stream after target removal, churn or a backwards reset clock", () => {
    const ledger = createKvEvictionResetLedger();
    const oldRequest = ledger.snapshot();
    ledger.note(["target"], now);
    ledger.note(["target"], new Date(now.getTime() - 1000));
    expect(ledger.resetMs("target", oldRequest)).toBe(Number.POSITIVE_INFINITY);
    expect(ledger.resetMs("target", ledger.snapshot())).toBe(now.getTime());
    // Removed targets need no explicit delete: the ledger is bounded even if
    // every future reset is a different target. Old request tokens live alone.
    for (let index = 0; index < MAX_RESET_CAPACITIES * 3; index++)
      ledger.note([`churn-${index}`], new Date(now.getTime() + index));
    expect(ledger.size()).toBe(MAX_RESET_CAPACITIES);
    expect(
      qualifiesAsEvictionEvidence({ ...valid, resetAtMs: ledger.resetMs("target", oldRequest) }),
    ).toBe(false);
    // Completing in reverse request order cannot lower either frontier.
    const current = ledger.snapshot();
    expect(ledger.resetMs("target", current)).toBeGreaterThanOrEqual(now.getTime());
    expect(ledger.resetMs("target", oldRequest)).toBe(Number.POSITIVE_INFINITY);
  });
  it("preserves unrelated evidence before churn and fresh evidence after pruning", () => {
    const ledger = createKvEvictionResetLedger();
    const first = ledger.snapshot();
    ledger.note(["reset-target"], now);
    expect(ledger.resetMs("unrelated", first)).toBeUndefined();
    for (let index = 0; index < MAX_RESET_CAPACITIES + 1; index++)
      ledger.note([`churn-${index}`], now);
    const fresh = ledger.snapshot();
    expect(
      qualifiesAsEvictionEvidence({ ...valid, resetAtMs: ledger.resetMs("unrelated", fresh) }),
    ).toBe(true);
    expect(
      qualifiesAsEvictionEvidence({
        ...valid,
        evidence: { ...valid.evidence!, lastUsedAt: now.getTime() - 1 },
        resetAtMs: ledger.resetMs("unrelated", fresh),
      }),
    ).toBe(false);
  });
  it("fences a retained target reset even with equal or backwards timestamps", () => {
    for (const offset of [0, -1000]) {
      const ledger = createKvEvictionResetLedger();
      const requestGeneration = ledger.snapshot();
      ledger.note(["target"], new Date(now.getTime() + offset));
      expect(
        qualifiesAsEvictionEvidence({
          ...valid,
          resetAtMs: ledger.resetMs("target", requestGeneration),
        }),
      ).toBe(false);
      expect(
        qualifiesAsEvictionEvidence({
          ...valid,
          resetAtMs: ledger.resetMs("target", ledger.snapshot()),
        }),
      ).toBe(true);
    }
  });

  it("rejects malformed reset identifiers and dates without consuming capacity", () => {
    const ledger = createKvEvictionResetLedger();
    ledger.note(["", "a".repeat(129)], now);
    ledger.note(["target"], new Date(Number.NaN));
    expect(ledger.size()).toBe(0);
    expect(ledger.snapshot()).toBe(0);
  });
});
