import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cacheAffinityRecord: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  capacityLease: { groupBy: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-bytes" },
}));

import {
  affinityPrefixDigests,
  rankAffinityTargets,
  rememberAffinity,
  sweepExpiredAffinity,
} from "./cache-affinity.js";

const policy = {
  enabled: true,
  ttlSeconds: 600,
  maxRecords: 100,
  prefixWeight: 100,
  conversationWeight: 150,
  confirmedCacheWeight: 250,
  loadPenaltyWeight: 100,
};

const payload = {
  model: "alias",
  messages: [
    { role: "system", content: "secret instructions" },
    { role: "user", content: "secret prompt" },
  ],
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  temperature: 0.2,
};

describe("cache affinity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback) => callback(db));
    db.$queryRaw.mockResolvedValue([{ id: "pool" }]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([]);
    db.cacheAffinityRecord.deleteMany.mockResolvedValue({ count: 0 });
    db.cacheAffinityRecord.upsert.mockResolvedValue({});
    db.capacityLease.groupBy.mockResolvedValue([]);
  });

  it("separates tenants, runtimes, surfaces, ordered content, tools, and parameters", () => {
    const digest = (overrides: Partial<Parameters<typeof affinityPrefixDigests>[0]> = {}) =>
      affinityPrefixDigests({
        ownerId: "owner-a",
        surface: "OPENAI_CHAT_COMPLETIONS",
        payload,
        runtimeIdentity: "runtime-a",
        ...overrides,
      }).digests.at(-1);

    const baseline = digest();
    expect(digest()).toBe(baseline);
    expect(digest({ ownerId: "owner-b" })).not.toBe(baseline);
    expect(digest({ runtimeIdentity: "runtime-b" })).not.toBe(baseline);
    expect(digest({ surface: "ANTHROPIC_MESSAGES" })).not.toBe(baseline);
    expect(digest({ payload: { ...payload, messages: [...payload.messages].reverse() } })).not.toBe(
      baseline,
    );
    expect(digest({ payload: { ...payload, tools: [] } })).not.toBe(baseline);
    expect(digest({ payload: { ...payload, temperature: 0.3 } })).not.toBe(baseline);
  });

  it("supports scalar Responses input without storing or truncating it", () => {
    const first = affinityPrefixDigests({
      ownerId: "owner",
      surface: "OPENAI_RESPONSES",
      payload: { input: "first private input" },
      runtimeIdentity: "runtime",
    });
    const second = affinityPrefixDigests({
      ownerId: "owner",
      surface: "OPENAI_RESPONSES",
      payload: { input: "different private input" },
      runtimeIdentity: "runtime",
    });
    expect(first.digests).toHaveLength(1);
    expect(first.digests[0]).not.toBe(second.digests[0]);
    expect(first.digests[0]).not.toContain("private input");
  });

  it("selects the longest compatible prefix but lets load override a weak match", async () => {
    const targetA = {
      poolMemberId: "member-a",
      executionTargetId: "target-a",
      targetIdentity: "runtime-a",
    };
    const targetB = {
      poolMemberId: "member-b",
      executionTargetId: "target-b",
      targetIdentity: "runtime-b",
    };
    const a = affinityPrefixDigests({
      ownerId: "owner",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      runtimeIdentity: targetA.targetIdentity,
    });
    const b = affinityPrefixDigests({
      ownerId: "owner",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      runtimeIdentity: targetB.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: "target-a",
        targetIdentity: "runtime-a",
        prefixDigest: a.digests[0],
        conversationDigest: null,
        prefixDepth: 1,
        engineCacheConfirmed: false,
      },
      {
        executionTargetId: "target-b",
        targetIdentity: "runtime-b",
        prefixDigest: b.digests[1],
        conversationDigest: null,
        prefixDepth: 2,
        engineCacheConfirmed: false,
      },
    ]);
    db.capacityLease.groupBy.mockResolvedValue([
      { executionTargetId: "target-b", _count: { _all: 2 } },
    ]);

    const result = await rankAffinityTargets({
      ownerId: "owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      targets: [targetA, targetB],
    });

    expect(result.matchedPrefixDepth).toBe(2);
    expect(result.orderedTargetIds).toEqual(["target-a", "target-b"]);
    expect(result.scores).toEqual({ "target-a": 100, "target-b": 0 });
  });

  it("queries only unexpired owner-scoped records with target identities", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rankAffinityTargets({
      ownerId: "owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      targets: [
        { poolMemberId: "a", executionTargetId: "target-a", targetIdentity: "runtime-a" },
        { poolMemberId: "b", executionTargetId: "target-b", targetIdentity: "runtime-b" },
      ],
      now,
    });
    expect(db.cacheAffinityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "owner",
          poolId: "pool",
          expiresAt: { gt: now },
        }),
      }),
    );
  });

  it("persists digests only, refreshes TTL, and enforces the row bound", async () => {
    db.cacheAffinityRecord.findMany.mockResolvedValue([{ id: "old" }]);
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rememberAffinity({
      ownerId: "owner",
      poolId: "pool",
      policy: { ...policy, maxRecords: 1 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      target: {
        poolMemberId: "member",
        executionTargetId: "target",
        targetIdentity: "runtime",
      },
      now,
    });
    const serializedWrites = JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls);
    expect(serializedWrites).not.toContain("secret prompt");
    expect(serializedWrites).not.toContain("secret instructions");
    expect(serializedWrites).not.toContain("lookup");
    expect(db.cacheAffinityRecord.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old"] } },
    });
  });

  it("sweeps expired rows in bounded batches", async () => {
    db.cacheAffinityRecord.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    db.cacheAffinityRecord.deleteMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-08-25T12:00:00.000Z");
    await expect(sweepExpiredAffinity({ now, limit: 2 })).resolves.toBe(2);
    expect(db.cacheAffinityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, where: { expiresAt: { lte: now } } }),
    );
  });
});
