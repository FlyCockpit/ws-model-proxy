import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cacheAffinityRecord: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
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
  type AffinityTarget,
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

const digestArgs = (
  runtimeIdentity: string,
  requestPayload: Record<string, unknown>,
  surface = "openai-chat",
) => ({
  ownerId: "owner",
  resourceOwnerId: "owner",
  poolId: "pool",
  securityScope: "token",
  surface,
  payload: requestPayload,
  runtimeIdentity,
});

const affinityRow = ({
  target: affinityTarget,
  material,
  prefixDigest = null as string | null,
  prefixDepth = 0,
  conversationDigest = null as string | null,
  digestVersion = 4,
  engineCacheConfirmed = false,
}: {
  target: ReturnType<typeof target>;
  material: ReturnType<typeof affinityPrefixDigests>;
  prefixDigest?: string | null;
  prefixDepth?: number;
  conversationDigest?: string | null;
  digestVersion?: number;
  engineCacheConfirmed?: boolean;
}) => ({
  executionTargetId: affinityTarget.executionTargetId,
  targetIdentity: affinityTarget.targetIdentity,
  bindingDigest: material.bindingDigest,
  prefixDigest,
  conversationDigest,
  prefixDepth,
  digestVersion,
  engineCacheConfirmed,
});

const cap8 = (affinityTarget: ReturnType<typeof target>) => ({
  ...affinityTarget,
  hardConcurrencyLimit: 8,
});

describe("cache affinity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback) => callback(db));
    db.$queryRaw.mockResolvedValue([{ id: "pool" }]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([]);
    db.cacheAffinityRecord.findFirst.mockResolvedValue(null);
    db.cacheAffinityRecord.deleteMany.mockResolvedValue({ count: 0 });
    db.cacheAffinityRecord.upsert.mockResolvedValue({});
    db.capacityLease.groupBy.mockResolvedValue([]);
    db.capacityWaiter.groupBy.mockResolvedValue([]);
  });

  it("separates tenants, runtimes, surfaces, ordered content, tools, and parameters", () => {
    const digest = (overrides: Partial<Parameters<typeof affinityPrefixDigests>[0]> = {}) =>
      affinityPrefixDigests({
        ownerId: "owner-a",
        resourceOwnerId: "resource-owner",
        poolId: "pool",
        securityScope: "token-a",
        accessGrantId: "grant-a",
        surface: "OPENAI_CHAT_COMPLETIONS",
        payload,
        runtimeIdentity: "runtime-a",
        ...overrides,
      }).digests.at(-1);

    const baseline = digest();
    expect(digest()).toBe(baseline);
    expect(digest({ ownerId: "owner-b" })).not.toBe(baseline);
    expect(digest({ securityScope: "token-b" })).not.toBe(baseline);
    expect(digest({ accessGrantId: "grant-b" })).not.toBe(baseline);
    expect(digest({ runtimeIdentity: "runtime-b" })).not.toBe(baseline);
    expect(digest({ surface: "ANTHROPIC_MESSAGES" })).not.toBe(baseline);
    const turns = {
      ...payload,
      messages: [
        { role: "user", content: "U1" },
        { role: "assistant", content: "A1" },
      ],
    };
    expect(digest({ payload: { ...turns, messages: [...turns.messages].reverse() } })).not.toBe(
      digest({ payload: turns }),
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
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { input: "first private input" },
      runtimeIdentity: "runtime",
    });
    const second = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { input: "different private input" },
      runtimeIdentity: "runtime",
    });
    expect(first.digests).toHaveLength(1);
    expect(first.digests[0]).not.toBe(second.digests[0]);
    expect(first.digests[0]).not.toContain("private input");
  });

  it("keeps explicit conversation identity stable across turns while exact prefixes change", () => {
    const digest = (requestPayload: Record<string, unknown>) =>
      affinityPrefixDigests({
        ownerId: "tenant",
        resourceOwnerId: "pool-owner",
        poolId: "pool",
        securityScope: "token-a",
        accessGrantId: "grant-a",
        surface: "OPENAI_RESPONSES",
        payload: requestPayload,
        runtimeIdentity: "target-runtime",
      });
    const first = digest({
      conversation: "conversation-secret",
      input: "turn one",
      instructions: "first instructions",
      tools: [{ name: "first-tool" }],
      temperature: 0.1,
    });
    const second = digest({
      conversation: "conversation-secret",
      input: "turn two",
      instructions: "changed instructions",
      tools: [{ name: "second-tool" }],
      temperature: 0.9,
    });
    expect(second.conversationDigest).toBe(first.conversationDigest);
    expect(second.bindingDigest).toBe(first.bindingDigest);
    expect(second.digests).not.toEqual(first.digests);
    expect(first.conversationDigest).not.toContain("conversation-secret");

    for (const isolation of [
      { ownerId: "other-tenant" },
      { resourceOwnerId: "other-owner" },
      { poolId: "other-pool" },
      { securityScope: "token-b" },
      { accessGrantId: "grant-b" },
    ]) {
      expect(
        affinityPrefixDigests({
          ownerId: "tenant",
          resourceOwnerId: "pool-owner",
          poolId: "pool",
          securityScope: "token-a",
          accessGrantId: "grant-a",
          surface: "OPENAI_RESPONSES",
          payload: { conversation: "conversation-secret", input: "turn one" },
          runtimeIdentity: "target-runtime",
          ...isolation,
        }).conversationDigest,
      ).not.toBe(first.conversationDigest);
    }
  });

  it("persists an explicit conversation even when there are no content prefixes", async () => {
    await rememberAffinity({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "grant-and-token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation-only" },
      target: target("target", "runtime"),
    });
    expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prefixDigest: null,
        prefixDepth: 0,
        digestVersion: 4,
        conversationDigest: expect.any(String),
      }),
    });
  });

  it("ranks a prior explicit conversation after content and sampling fields change", async () => {
    const selected = target("target-a", "runtime-a");
    const prior = affinityPrefixDigests({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation", input: "first", temperature: 0.1 },
      runtimeIdentity: selected.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: selected.executionTargetId,
        targetIdentity: selected.targetIdentity,
        bindingDigest: prior.bindingDigest,
        prefixDigest: null,
        conversationDigest: prior.conversationDigest,
        prefixDepth: 0,
        digestVersion: 4,
        engineCacheConfirmed: false,
      },
    ]);
    const ranked = await rankAffinityTargets({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "conversation",
        input: "second",
        instructions: "changed",
        tools: [{ name: "changed" }],
        temperature: 0.9,
      },
      targets: [target("target-b", "runtime-b"), selected],
    });
    expect(ranked.orderedTargetIds[0]).toBe(selected.executionTargetId);
    expect(ranked.conversationMatches[selected.executionTargetId]).toBe(true);
    expect(ranked.prefixDepths[selected.executionTargetId]).toBe(0);
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
      securityScope: "token",
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
    const continuationPayload = {
      ...payload,
      messages: [...payload.messages, { role: "assistant", content: "secret answer" }],
    };
    const a = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      runtimeIdentity: targetA.targetIdentity,
    });
    const b = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      runtimeIdentity: targetB.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: "target-a",
        targetIdentity: "runtime-a",
        bindingDigest: a.bindingDigest,
        prefixDigest: a.digests[0],
        conversationDigest: null,
        prefixDepth: 1,
        digestVersion: 4,
        engineCacheConfirmed: false,
      },
      {
        executionTargetId: "target-b",
        targetIdentity: "runtime-b",
        bindingDigest: b.bindingDigest,
        prefixDigest: b.digests[1],
        conversationDigest: null,
        prefixDepth: 2,
        digestVersion: 4,
        engineCacheConfirmed: false,
      },
    ]);
    db.capacityLease.groupBy.mockResolvedValue([{ capacityId: "capacity-b", _count: { _all: 2 } }]);

    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      targets: [targetA, targetB],
    });

    expect(result.matchedPrefixDepth).toBe(2);
    expect(result.orderedTargetIds).toEqual(["target-a", "target-b"]);
    expect(result.scores).toEqual({ "target-a": 100, "target-b": 0 });
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

  it("persists instruction prefixes for system-only Chat and writes digestVersion 4 on create only", async () => {
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-chat",
      payload: { messages: [{ role: "system", content: "secret instructions" }] },
      target: target("target", "runtime"),
    });
    expect(db.cacheAffinityRecord.upsert).toHaveBeenCalled();
    const creates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create);
    const updates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.update);
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create.digestVersion).toBe(4);
      expect(create.prefixDigest).toEqual(expect.any(String));
      expect(create.conversationDigest).toBeNull();
      expect(create.prefixDepth).toBeGreaterThan(0);
    }
    for (const update of updates) {
      expect(update).not.toHaveProperty("digestVersion");
    }
    expect(JSON.stringify(creates)).not.toContain("secret instructions");
    expect(JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls)).not.toContain(
      "secret instructions",
    );
  });

  it("writes digestVersion 4 on conversation-prefix and session creates and omits it on updates", async () => {
    const requestPayload = {
      conversation: "conversation-secret",
      input: "turn one",
      instructions: "secret instructions",
    };
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-responses",
      payload: requestPayload,
      target: target("target", "runtime"),
    });
    const prefixCreates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create);
    const prefixUpdates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.update);
    expect(prefixCreates.length).toBeGreaterThan(1);
    for (const create of prefixCreates) {
      expect(create.digestVersion).toBe(4);
    }
    for (const update of prefixUpdates) {
      expect(update).not.toHaveProperty("digestVersion");
    }
    expect(db.cacheAffinityRecord.create.mock.calls[0]?.[0].data.digestVersion).toBe(4);
    expect(JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls)).not.toContain(
      "secret instructions",
    );
    expect(JSON.stringify(db.cacheAffinityRecord.create.mock.calls)).not.toContain(
      "conversation-secret",
    );

    db.cacheAffinityRecord.findFirst.mockResolvedValue({ id: "existing-session" });
    db.cacheAffinityRecord.upsert.mockClear();
    db.cacheAffinityRecord.create.mockClear();
    db.cacheAffinityRecord.update.mockClear();
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-responses",
      payload: requestPayload,
      target: target("target", "runtime"),
    });
    expect(db.cacheAffinityRecord.create).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.update).toHaveBeenCalledWith({
      where: { id: "existing-session" },
      data: expect.not.objectContaining({ digestVersion: expect.anything() }),
    });
    expect(db.cacheAffinityRecord.update.mock.calls[0]?.[0].data).not.toHaveProperty(
      "digestVersion",
    );
  });

  it("deduplicates the exact prefix while storing distinct conversation identities", async () => {
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
        input.where.tenantUserId_poolId_executionTargetId_targetIdentity_bindingDigest_prefixDigest
          .prefixDigest,
    );
    expect(new Set(uniqueInputs).size).toBe(1);
    expect(db.cacheAffinityRecord.create).toHaveBeenCalledTimes(2);
    const conversations = db.cacheAffinityRecord.create.mock.calls.map(
      ([input]) => input.data.conversationDigest,
    );
    expect(new Set(conversations).size).toBe(2);
  });

  it("canonicalizes telemetry surfaces onto production ProtocolSurface HMACs", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      payload,
      runtimeIdentity: "runtime",
    } as const;
    const chat = affinityPrefixDigests({ ...args, surface: "openai-chat" });
    const chatAlias = affinityPrefixDigests({ ...args, surface: "OPENAI_CHAT_COMPLETIONS" });
    expect(chatAlias.bindingDigest).toBe(chat.bindingDigest);
    expect(chatAlias.instructionDigests).toEqual(chat.instructionDigests);
    expect(chatAlias.digests).toEqual(chat.digests);

    const responsesPayload = { instructions: "S", input: "U", temperature: 0.2 };
    const responses = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: responsesPayload,
    });
    const responsesAlias = affinityPrefixDigests({
      ...args,
      surface: "OPENAI_RESPONSES",
      payload: responsesPayload,
    });
    expect(responsesAlias.bindingDigest).toBe(responses.bindingDigest);
    expect(responsesAlias.instructionDigests).toEqual(responses.instructionDigests);
    expect(responsesAlias.digests).toEqual(responses.digests);

    const anthropicPayload = { system: "S", messages: [{ role: "user", content: "U" }] };
    const anthropic = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: anthropicPayload,
    });
    const anthropicAlias = affinityPrefixDigests({
      ...args,
      surface: "ANTHROPIC_MESSAGES",
      payload: anthropicPayload,
    });
    expect(anthropicAlias.bindingDigest).toBe(anthropic.bindingDigest);
    expect(anthropicAlias.instructionDigests).toEqual(anthropic.instructionDigests);
    expect(anthropicAlias.digests).toEqual(anthropic.digests);
  });

  it("splits Chat system into instruction HMACs and user turns into conversation prefixes", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "openai-chat",
      runtimeIdentity: "runtime",
    };
    const noTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
      },
    });
    expect(noTools.instructionDigests).toHaveLength(1);
    expect(noTools.digests).toHaveLength(1);
    expect(noTools.isContinuation).toBe(false);

    const withTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    expect(withTools.instructionDigests).toHaveLength(2);
    expect(withTools.instructionDigests[0]).toBe(noTools.instructionDigests[0]);
    expect(withTools.digests).not.toEqual(noTools.digests);

    const otherTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        tools: [{ type: "function", function: { name: "other" } }],
      },
    });
    expect(otherTools.instructionDigests[0]).toBe(noTools.instructionDigests[0]);
    expect(otherTools.instructionDigests[1]).not.toBe(withTools.instructionDigests[1]);
  });

  it("caps instruction HMAC units at 8 and keeps tools as the last unit", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "openai-chat",
      runtimeIdentity: "runtime",
    };
    const nine = Array.from({ length: 9 }, (_, index) => ({
      role: "system",
      content: `S${index}`,
    }));
    const nineText = affinityPrefixDigests({
      ...args,
      payload: { messages: [...nine, { role: "user", content: "U" }] },
    });
    expect(nineText.instructionDigests).toHaveLength(8);

    const tools = [{ type: "function", function: { name: "lookup" } }];
    const eightPlusTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 8), { role: "user", content: "U" }],
        tools,
      },
    });
    const sevenPlusTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 7), { role: "user", content: "U" }],
        tools,
      },
    });
    expect(eightPlusTools.instructionDigests).toHaveLength(8);
    expect(eightPlusTools.instructionDigests).toEqual(sevenPlusTools.instructionDigests);
    expect(eightPlusTools.instructionDigests[0]).toBe(
      affinityPrefixDigests({
        ...args,
        payload: {
          messages: [
            { role: "system", content: "S0" },
            { role: "user", content: "U" },
          ],
        },
      }).instructionDigests[0],
    );
    const otherTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 8), { role: "user", content: "U" }],
        tools: [{ type: "function", function: { name: "other" } }],
      },
    });
    expect(otherTools.instructionDigests[7]).not.toBe(eightPlusTools.instructionDigests[7]);
    expect(otherTools.instructionDigests.slice(0, 7)).toEqual(
      eightPlusTools.instructionDigests.slice(0, 7),
    );

    const ninthDiffers = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          ...nine.slice(0, 8),
          { role: "system", content: "S8-other" },
          { role: "user", content: "U" },
        ],
      },
    });
    expect(ninthDiffers.instructionDigests).toEqual(nineText.instructionDigests);
    expect(ninthDiffers.digests).not.toEqual(nineText.digests);
  });

  it("omits remaining instruction HMACs when a unit exceeds the canonical byte cap", () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 64);
    let result: ReturnType<typeof affinityPrefixDigests> | undefined;
    expect(() => {
      result = affinityPrefixDigests({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        surface: "openai-chat",
        runtimeIdentity: "runtime",
        payload: {
          messages: [
            { role: "system", content: huge },
            { role: "system", content: "after" },
            { role: "user", content: "U" },
          ],
        },
      });
    }).not.toThrow();
    expect(result?.instructionDigests).toEqual([]);
    expect(result?.digests).toHaveLength(1);
  });

  it("keeps stray unconsumed fields in parameters so conversation prefixes do not collide", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      runtimeIdentity: "runtime",
    };
    const chatPromptNone = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }] },
    });
    const chatPromptA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        prompt: "abc",
      },
    });
    const chatPromptB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        prompt: "xyz",
      },
    });
    expect(chatPromptA.digests).toHaveLength(1);
    expect(chatPromptB.digests).toHaveLength(1);
    expect(chatPromptNone.digests).toHaveLength(1);
    expect(chatPromptA.instructionDigests).toEqual([]);
    expect(chatPromptB.instructionDigests).toEqual([]);
    expect(chatPromptA.instructionDigests).toEqual(chatPromptNone.instructionDigests);
    expect(chatPromptA.digests).not.toEqual(chatPromptB.digests);
    expect(chatPromptA.digests).not.toEqual(chatPromptNone.digests);

    const malformedA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: "abc", temperature: 0.1 },
    });
    const malformedB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: "xyz", temperature: 0.1 },
    });
    expect(malformedA.digests).toEqual([]);
    expect(malformedB.digests).toEqual([]);
    expect(malformedA.instructionDigests).toEqual([]);
    // Binding is identical; the stray `messages` string lives in parameters and
    // only changes prefixBinding, which is observable once a conversation unit
    // exists. Pair with a Responses scalar input that also carries the stray.
    const responsesWithStrayMessagesA = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", messages: "abc" },
    });
    const responsesWithStrayMessagesB = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", messages: "xyz" },
    });
    expect(responsesWithStrayMessagesA.digests).not.toEqual(responsesWithStrayMessagesB.digests);

    const responsesSystemA = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", system: "A" },
    });
    const responsesSystemB = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", system: "B" },
    });
    expect(responsesSystemA.digests).not.toEqual(responsesSystemB.digests);

    const anthropicInstructionsA = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: { messages: [{ role: "user", content: "U" }], instructions: "A" },
    });
    const anthropicInstructionsB = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: { messages: [{ role: "user", content: "U" }], instructions: "B" },
    });
    expect(anthropicInstructionsA.digests).not.toEqual(anthropicInstructionsB.digests);

    const chatSystemA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }], system: "A" },
    });
    const chatSystemB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }], system: "B" },
    });
    expect(chatSystemA.instructionDigests).toEqual([]);
    expect(chatSystemB.instructionDigests).toEqual([]);
    expect(chatSystemA.digests).toHaveLength(1);
    expect(chatSystemA.digests).not.toEqual(chatSystemB.digests);
  });

  it("does not leak consumed messages, input, or tools into prefix-binding parameters", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      runtimeIdentity: "runtime",
    };
    const chatUser = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }] },
    });
    const chatContinued = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
      },
    });
    expect(chatContinued.digests[0]).toBe(chatUser.digests[0]);

    const responsesOne = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: [{ role: "user", content: "U" }] },
    });
    const responsesTwo = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: {
        input: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
      },
    });
    expect(responsesTwo.digests[0]).toBe(responsesOne.digests[0]);

    const toolsA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    const toolsB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    expect(toolsB.digests[0]).toBe(toolsA.digests[0]);
    expect(toolsA.digests[0]).not.toBe(chatUser.digests[0]);
  });

  it("routes fresh Chat by availability and uses instruction depth only as a tie-break", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(seeded.instructionDigests[0]).toBe(ranked.instructionDigests[0]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const busy = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(busy.orderedTargetIds).toEqual(["target-b", "target-a"]);
    expect(busy.instructionDepths?.["target-a"]).toBe(1);
    expect(busy.prefixDepths["target-a"]).toBe(0);
    expect(busy.prefixDepths["target-b"]).toBe(0);

    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const tied = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(tied.orderedTargetIds[0]).toBe("target-a");
    expect(tied.instructionDepths?.["target-a"]).toBeGreaterThanOrEqual(1);
    expect(tied.prefixDepths["target-a"]).toBe(0);
    expect(tied.reasons["target-a"]).toContain("instruction:");
    expect(tied.reasons["target-a"]).toContain("continuation:false");
  });

  it("does not pin continuations that share only the instruction layer", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
        { role: "assistant", content: "first" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
        { role: "assistant", content: "other" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds).toEqual(["target-b", "target-a"]);
    expect(result.prefixDepths["target-a"]).toBe(0);
    expect(result.instructionDepths?.["target-a"]).toBe(1);
    expect(affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload)).digests).not.toEqual(
      ranked.digests,
    );
  });

  it("keeps a real continuation stuck under 1/8 load at scored prefix depth 2", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
        { role: "user", content: "next" },
      ],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.digests.slice(0, 2)).toEqual(seeded.digests);
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      seeded.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      ),
    );
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-a");
    expect(result.prefixDepths["target-a"]).toBe(2);
  });

  it("ignores v3 rows even when the Prisma mock returns a matching instruction digest", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    expect(query?.where.digestVersion).toBe(4);
    expect(query?.select.digestVersion).toBe(true);

    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
        digestVersion: 3,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(result.instructionDepths?.["target-a"]).toBe(0);
    expect(result.orderedTargetIds[0]).toBe("target-b");
  });

  it("queries instruction prefix HMACs even when the conversation digest list is empty", async () => {
    const warm = target("target-a", "runtime-a");
    const idle = target("target-b", "runtime-b");
    const rankPayload = { messages: [{ role: "system", content: "S" }] };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.digests).toEqual([]);
    expect(ranked.instructionDigests.length).toBeGreaterThan(0);
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [warm, idle],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    const prefixIn = query?.where.OR.find(
      (clause: { prefixDigest?: { in: string[] } }) => clause.prefixDigest?.in,
    )?.prefixDigest.in;
    expect(prefixIn).toEqual(expect.arrayContaining(ranked.instructionDigests));
  });

  it("returns original Completions order without querying records or load", async () => {
    const busy = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_COMPLETIONS",
      payload: { prompt: "complete this" },
      targets: [{ ...busy, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds).toEqual(["target-a", "target-b"]);
    expect(db.cacheAffinityRecord.findMany).not.toHaveBeenCalled();
    expect(db.capacityLease.groupBy).not.toHaveBeenCalled();
    expect(db.capacityWaiter.groupBy).not.toHaveBeenCalled();
  });

  it("does not fire the confirmed-cache bonus on instruction-only matches", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
        engineCacheConfirmed: true,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-b");
    expect(result.scores["target-a"]).toBe(-13);
    expect(result.reasons["target-a"]).toContain("confirmed:false");
  });

  it("spills or keeps continuations using the worked-example load and health arithmetic", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const continuation = (depth: number) => {
      const messages: Record<string, string>[] = [{ role: "system", content: "S" }];
      for (let index = 0; index < depth; index += 1) {
        messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `t${index}` });
      }
      return { messages };
    };
    const rankAt = async (
      depth: number,
      warmOverrides: Partial<AffinityTarget>,
      seedInstruction: boolean,
    ) => {
      const rankPayload = continuation(depth);
      const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
      const rows = ranked.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      );
      if (seedInstruction && ranked.instructionDigests[0]) {
        rows.push(
          affinityRow({
            target: warm,
            material: ranked,
            prefixDigest: ranked.instructionDigests[0],
            prefixDepth: 1,
          }),
        );
      }
      db.cacheAffinityRecord.findMany.mockResolvedValue(rows);
      db.capacityLease.groupBy.mockResolvedValue([]);
      db.capacityWaiter.groupBy.mockResolvedValue([]);
      return rankAffinityTargets({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        policy,
        surface: "openai-chat",
        payload: rankPayload,
        targets: [idle, { ...warm, ...warmOverrides }],
      });
    };

    const halfOpenIdle = await rankAt(2, { healthPenalty: 200 }, true);
    expect(halfOpenIdle.scores["target-a"]).toBe(0);
    expect(halfOpenIdle.scores["target-b"]).toBe(0);
    expect(halfOpenIdle.orderedTargetIds[0]).toBe("target-a");

    const halfOpenLoaded = await rankAt(2, { healthPenalty: 200, activeLoad: 1 }, true);
    expect(halfOpenLoaded.orderedTargetIds[0]).toBe("target-b");

    const depth3 = await rankAt(3, { healthPenalty: 200 }, true);
    expect(depth3.orderedTargetIds[0]).toBe("target-a");
    expect(depth3.scores["target-a"]).toBe(100);

    const waiters = await rankAt(2, { waitingLoad: 3 }, true);
    expect(waiters.orderedTargetIds[0]).toBe("target-b");

    const deep = await rankAt(20, { waitingLoad: 5, activeLoad: 1 }, true);
    expect(deep.orderedTargetIds[0]).toBe("target-a");
    expect(deep.scores["target-a"]).toBe(1487);
  });

  it("does not pin fresh Responses instructions, input system items, or Anthropic system", async () => {
    const cases = [
      {
        surface: "openai-responses",
        seed: { instructions: "S", input: "user" },
        rank: { instructions: "S", input: "other" },
      },
      {
        surface: "openai-responses",
        seed: {
          input: [
            { role: "system", content: "S" },
            { role: "user", content: "user" },
          ],
        },
        rank: {
          input: [
            { role: "system", content: "S" },
            { role: "user", content: "other" },
          ],
        },
      },
      {
        surface: "anthropic-messages",
        seed: { system: "S", messages: [{ role: "user", content: "user" }] },
        rank: { system: "S", messages: [{ role: "user", content: "other" }] },
      },
    ] as const;
    for (const testCase of cases) {
      const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
      const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
      const ranked = affinityPrefixDigests(
        digestArgs(warm.targetIdentity, testCase.rank, testCase.surface),
      );
      db.cacheAffinityRecord.findMany.mockResolvedValue(
        ranked.instructionDigests.map((prefixDigest, index) =>
          affinityRow({
            target: warm,
            material: ranked,
            prefixDigest,
            prefixDepth: index + 1,
          }),
        ),
      );
      const result = await rankAffinityTargets({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        policy,
        surface: testCase.surface,
        payload: testCase.rank,
        targets: [{ ...warm, activeLoad: 1 }, idle],
      });
      expect(result.orderedTargetIds, testCase.surface).toEqual(["target-b", "target-a"]);
      expect(result.prefixDepths["target-a"], testCase.surface).toBe(0);
    }
  });

  it("still warmth-matches the same system when tools differ, without using prefixWeight", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
      tools: [{ type: "function", function: { name: "other" } }],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.instructionDigests[0]).toBe(seeded.instructionDigests[0]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: seeded.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(result.scores["target-a"]).toBe(result.scores["target-b"]);
    expect(result.instructionDepths?.["target-a"]).toBe(1);
    expect(result.prefixDepths["target-a"]).toBe(0);
    expect(result.orderedTargetIds[0]).toBe("target-a");
  });

  it("documents that a shared kickoff plus assistant prefill still pins", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "user", content: "shared kickoff" },
        { role: "assistant", content: "prefill" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      ranked.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      ),
    );
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-a");
    expect(result.prefixDepths["target-a"]).toBeGreaterThanOrEqual(1);
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
