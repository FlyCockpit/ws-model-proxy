import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cacheAffinityRecord: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  capacityLease: { groupBy: vi.fn() },
  capacityWaiter: { groupBy: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-bytes" },
}));

import {
  affinityPrefixDigests,
  buildAffinityTargetIdentity,
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

const target = (
  executionTargetId: string,
  targetIdentity: string,
  capacityId = executionTargetId,
) => ({
  poolMemberId: `member-${executionTargetId}`,
  executionTargetId,
  targetIdentity,
  capacityId,
  hardConcurrencyLimit: 1,
  healthPenalty: 0,
  publicEgressPenalty: 0,
  costPenalty: 0,
});

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
    db.capacityWaiter.groupBy.mockResolvedValue([]);
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
    expect(digest({ payload: { ...payload, vendor_extension: { mode: "different" } } })).not.toBe(
      baseline,
    );
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

  it("invalidates identity across native surface, adapter, endpoint, and every runtime projection", () => {
    const base = {
      executionTargetId: "target",
      endpointIdentity: "endpoint",
      upstreamModelId: "model",
      runtimeIdentityKey: "runtime-key",
      runtimeModel: "runtime-model",
      runtimeRevision: "revision",
      tokenizer: "tokenizer",
      tokenizerVersion: "tokenizer-version",
      template: "template",
      templateVersion: "template-version",
      engine: "engine",
      cacheNamespace: "namespace",
      requestedSurface: "OPENAI_RESPONSES",
      nativeSurface: "OPENAI_RESPONSES",
      mode: "native",
      adapterVersion: "native",
    };
    const baseline = buildAffinityTargetIdentity(base);
    for (const [key, value] of Object.entries({
      endpointIdentity: "other-endpoint",
      runtimeModel: "other-runtime",
      runtimeRevision: "other-revision",
      tokenizer: "other-tokenizer",
      tokenizerVersion: "other-tokenizer-version",
      template: "other-template",
      templateVersion: "other-template-version",
      engine: "other-engine",
      cacheNamespace: "other-namespace",
      nativeSurface: "ANTHROPIC_MESSAGES",
      mode: "adapted",
      adapterVersion: "2.0.0",
    })) {
      expect(buildAffinityTargetIdentity({ ...base, [key]: value })).not.toBe(baseline);
    }
    expect(baseline).toHaveLength(43);
    expect(
      buildAffinityTargetIdentity({ ...base, runtimeIdentityKey: "a\u001fb", runtimeModel: "c" }),
    ).not.toBe(
      buildAffinityTargetIdentity({ ...base, runtimeIdentityKey: "a", runtimeModel: "b\u001fc" }),
    );
    expect(
      buildAffinityTargetIdentity({
        ...base,
        runtimeIdentityKey: "x".repeat(500),
        runtimeModel: "y".repeat(500),
        tokenizer: "z".repeat(500),
        template: "t".repeat(500),
      }),
    ).toHaveLength(43);
  });

  it("never treats the missing-conversation sentinel as conversation affinity", async () => {
    const affinityTarget = target("target-a", "runtime-a");
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: { messages: [{ role: "user", content: "unrelated" }] },
      targets: [affinityTarget, target("target-b", "runtime-b")],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(query?.where.OR)).not.toContain("conversationDigest");
  });

  it("selects the longest compatible prefix but lets load override a weak match", async () => {
    const targetA = target("target-a", "runtime-a", "capacity-a");
    const targetB = target("target-b", "runtime-b", "capacity-b");
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
    db.capacityLease.groupBy.mockResolvedValue([{ capacityId: "capacity-b", _count: { _all: 2 } }]);

    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
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

  it("does not let affinity outweigh queue, health, public-egress, and cost penalties", async () => {
    const expensive = {
      ...target("target-a", "runtime-a", "capacity-a"),
      healthPenalty: 100,
      publicEgressPenalty: 100,
      costPenalty: 100,
    };
    const local = target("target-b", "runtime-b", "capacity-b");
    const prefixes = affinityPrefixDigests({
      ownerId: "owner",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      runtimeIdentity: expensive.targetIdentity,
    });
    const deepestDigest = prefixes.digests[prefixes.digests.length - 1];
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: expensive.executionTargetId,
        targetIdentity: expensive.targetIdentity,
        prefixDigest: deepestDigest,
        prefixDepth: prefixes.digests.length,
        conversationDigest: prefixes.conversationDigest,
        engineCacheConfirmed: false,
      },
    ]);
    db.capacityWaiter.groupBy.mockResolvedValue([
      { capacityId: expensive.capacityId, _count: { _all: 10 } },
    ]);

    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      targets: [expensive, local],
    });

    expect(result.orderedTargetIds[0]).toBe(local.executionTargetId);
  });

  it("queries only unexpired owner-scoped records with target identities", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rankAffinityTargets({
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      targets: [target("target-a", "runtime-a"), target("target-b", "runtime-b")],
      now,
    });
    expect(db.cacheAffinityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "pool-owner",
          tenantUserId: "grantee",
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
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy: { ...policy, maxRecords: 1 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      target: target("target", "runtime"),
      now,
    });
    const serializedWrites = JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls);
    expect(serializedWrites).not.toContain("secret prompt");
    expect(serializedWrites).not.toContain("secret instructions");
    expect(serializedWrites).not.toContain("lookup");
    expect(serializedWrites).toContain("grantee");
    expect(serializedWrites).toContain("pool-owner");
    expect(db.cacheAffinityRecord.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old"] } },
    });
  });

  it("keeps the same prefix independently for multiple conversation digests", async () => {
    for (const conversation of ["conversation-a", "conversation-b"]) {
      await rememberAffinity({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: "shared prefix", conversation },
        target: target("target", "runtime"),
      });
    }
    const uniqueInputs = db.cacheAffinityRecord.upsert.mock.calls.map(
      ([input]) =>
        input.where
          .tenantUserId_poolId_executionTargetId_targetIdentity_prefixDigest_conversationDigest
          .conversationDigest,
    );
    expect(new Set(uniqueInputs).size).toBe(2);
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
