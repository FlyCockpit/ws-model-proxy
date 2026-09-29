// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[cache-affinity] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("cache affinity PostgreSQL concurrency and retention", () => {
  const db = databaseUrl ? createFixturePrismaClient(databaseUrl) : undefined;
  let service: typeof import("./cache-affinity.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "cache-affinity-integration-secret-32-bytes";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    service = await import("./cache-affinity.js");
  });

  afterAll(async () => db?.$disconnect());

  const fixtureUserIds: string[] = [];
  afterEach(async () => {
    if (!db) return;
    for (const id of fixtureUserIds.splice(0)) await db.user.deleteMany({ where: { id } });
  });

  async function fixture() {
    if (!db) throw new Error("database unavailable");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Affinity owner", email: `affinity-owner-${suffix}@example.test` },
    });
    const tenant = await db.user.create({
      data: { name: "Affinity tenant", email: `affinity-tenant-${suffix}@example.test` },
    });
    const otherTenant = await db.user.create({
      data: { name: "Other tenant", email: `affinity-other-${suffix}@example.test` },
    });
    const device = await db.cliDevice.create({
      data: { userId: owner.id, slug: `device-${suffix}` },
    });
    const endpoint = await db.endpoint.create({
      data: {
        userId: owner.id,
        cliDeviceId: device.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `capacity-${suffix}`,
        runtimeIdentityKey: `runtime-${suffix}`,
        runtimeModel: "model",
      },
    });
    const targets = await Promise.all(
      ["a", "b"].map(async (label) => {
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: `${label}-${suffix}`,
            encodedModelId: `${label}-${suffix}`,
          },
        });
        return db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacity.id },
        });
      }),
    );
    const pool = await db.modelPool.create({
      data: { userId: owner.id, name: "Affinity pool", slug: `affinity-${suffix}` },
    });
    fixtureUserIds.push(owner.id, tenant.id, otherTenant.id);
    const target = (index: number) => ({
      poolMemberId: `member-${index}`,
      executionTargetId: targets[index]!.id,
      targetIdentity: `identity-${index}`,
      capacityId: capacity.id,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    });
    return { owner, tenant, otherTenant, pool, target };
  }

  function rowCount(rows: unknown) {
    if (!Array.isArray(rows)) throw new Error("expected a real SQL row array");
    return rows.length;
  }

  const policy = {
    enabled: true,
    ttlSeconds: 60,
    maxRecords: 3,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };

  it("keeps a conversation on its target across changed turn fields without leaking across tenant, token, or runtime", async () => {
    if (!db) return;
    const row = await fixture();
    await service.rememberAffinity({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy: { ...policy, maxRecords: 8 },
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "private-conversation-id",
        input: "first turn",
        instructions: "old instructions",
        tools: [{ name: "old-tool" }],
        temperature: 0.1,
      },
      target: row.target(0),
    });
    const created = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
      select: {
        digestVersion: true,
        prefixDigest: true,
        prefixDepth: true,
        conversationDigest: true,
      },
    });
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((record) => record.digestVersion === 4)).toBe(true);
    expect(
      created
        .filter((record) => record.prefixDigest !== null)
        .every((record) => record.prefixDepth > 0 && record.conversationDigest === null),
    ).toBe(true);
    const changedTurn = {
      conversation: "private-conversation-id",
      input: "second turn",
      instructions: "new instructions",
      tools: [{ name: "new-tool" }],
      temperature: 0.9,
    };
    const ranked = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: changedTurn,
      targets: [row.target(1), row.target(0)],
    });
    expect(ranked.orderedTargetIds[0]).toBe(row.target(0).executionTargetId);
    expect(ranked.conversationMatches[row.target(0).executionTargetId]).toBe(true);
    expect(ranked.prefixDepths[row.target(0).executionTargetId]).toBe(0);

    for (const isolation of [
      { ownerId: row.otherTenant.id, securityScope: "token-a", accessGrantId: "grant-a" },
      { ownerId: row.tenant.id, securityScope: "token-b", accessGrantId: "grant-a" },
      { ownerId: row.tenant.id, securityScope: "token-a", accessGrantId: "grant-b" },
    ]) {
      const isolated = await service.rankAffinityTargets({
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: changedTurn,
        targets: [row.target(1), row.target(0)],
        ...isolation,
      });
      expect(isolated.conversationMatches[row.target(0).executionTargetId]).toBe(false);
    }
    const replacementGrant = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-b",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "private-conversation-id",
        input: "first turn",
        instructions: "old instructions",
        tools: [{ name: "old-tool" }],
        temperature: 0.1,
      },
      targets: [row.target(1), row.target(0)],
    });
    expect(replacementGrant.prefixDepths[row.target(0).executionTargetId]).toBe(0);
    expect(replacementGrant.conversationMatches[row.target(0).executionTargetId]).toBe(false);
    const changedRuntime = { ...row.target(0), targetIdentity: "changed-runtime-binding" };
    const runtimeIsolated = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: changedTurn,
      targets: [row.target(1), changedRuntime],
    });
    expect(runtimeIsolated.conversationMatches[changedRuntime.executionTargetId]).toBe(false);
  });

  it("keeps one warm-session id across edited and shortened history and changed parameters", async () => {
    if (!db) return;
    const row = await fixture();
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
    };
    const start = Date.parse("2026-09-29T12:00:00Z");
    const at = (seconds: number) => new Date(start + seconds * 1000);
    const user = (content: string) => ({ role: "user", content });
    const assistant = (content: string) => ({ role: "assistant", content });
    const chat = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
      messages: [{ role: "system", content: "rules" }, ...messages],
      ...extra,
    });
    const remember = (
      payload: Record<string, unknown>,
      seconds: number,
      targetIndex = 0,
      overrides: Record<string, unknown> = {},
    ) =>
      service.rememberAffinity({
        ...base,
        ...overrides,
        payload,
        target: row.target(targetIndex),
        estimatedTokens: 10_000 + seconds,
        now: at(seconds),
      });
    const sessions = async () =>
      new Set(
        (
          await db.cacheAffinityRecord.findMany({
            where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
            select: { sessionId: true },
          })
        ).map((record) => record.sessionId),
      );

    // Turn 1, turn 2 (continuation), then an edited earlier turn and a
    // shortened history: one session throughout.
    await remember(chat([user("a")]), 1);
    const [first] = [...(await sessions())];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await remember(chat([user("a"), assistant("b"), user("c")]), 2);
    await remember(chat([user("a"), assistant("b"), user("c"), assistant("d"), user("e")]), 3);
    await remember(chat([user("a"), assistant("b"), user("EDITED"), assistant("x"), user("y")]), 4);
    await remember(chat([user("a"), assistant("b"), user("c")]), 5);
    expect(await sessions()).toEqual(new Set([first]));

    // A different conversation (fresh first message) is its own session; so is
    // the same history on another target (its KV lives elsewhere).
    await remember(chat([user("unrelated")]), 6);
    expect((await sessions()).size).toBe(2);
    await remember(chat([user("a"), assistant("b"), user("c")]), 7, 1);
    expect((await sessions()).size).toBe(3);

    // An explicit conversation keeps its session when the parameters change;
    // a tenant's records never join another tenant's.
    const explicit = (temperature: number, text: string) => ({
      conversation: "conv-1",
      input: text,
      temperature,
    });
    const responses = { surface: "OPENAI_RESPONSES" };
    await remember(explicit(0.1, "one"), 8, 0, responses);
    const afterFirst = await sessions();
    await remember(explicit(0.9, "one and two"), 9, 0, responses);
    expect((await sessions()).size).toBe(afterFirst.size);
    const conversationRecords = await db.cacheAffinityRecord.findMany({
      where: {
        tenantUserId: row.tenant.id,
        poolId: row.pool.id,
        explicitConversationDigest: service.affinityPrefixDigests({
          ...base,
          payload: explicit(0.1, "one"),
          surface: "OPENAI_RESPONSES",
          runtimeIdentity: row.target(0).targetIdentity,
        }).conversationDigest,
      },
      select: { sessionId: true },
    });
    expect(new Set(conversationRecords.map((record) => record.sessionId)).size).toBe(1);
    await service.rememberAffinity({
      ...base,
      ownerId: row.otherTenant.id,
      payload: chat([user("a"), assistant("b"), user("c")]),
      target: row.target(0),
      now: at(10),
    });
    const otherTenantSessions = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.otherTenant.id, poolId: row.pool.id },
      select: { sessionId: true },
    });
    expect(otherTenantSessions.every(({ sessionId }) => sessionId !== null)).toBe(true);
    expect(
      otherTenantSessions.some(({ sessionId }) =>
        (afterFirst as Set<string | null>).has(sessionId),
      ),
    ).toBe(false);
  });

  const userTurn = (content: string) => ({ role: "user", content });
  const assistantTurn = (content: string) => ({ role: "assistant", content });
  const history = [
    userTurn("first"),
    assistantTurn("answer"),
    userTurn("second"),
    assistantTurn("answer2"),
    userTurn("third"),
  ];
  const chat = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
    messages: [{ role: "system", content: "rules" }, ...messages],
    ...extra,
  });
  const changedTurns: { name: string; payload: Record<string, unknown>; explicit?: boolean }[] = [
    {
      name: "edit an earlier user turn",
      payload: chat([...history.slice(0, 2), userTurn("edited"), ...history.slice(3)]),
    },
    { name: "shorten history", payload: chat(history.slice(0, 3)) },
    {
      name: "change parameters",
      payload: chat([...history, assistantTurn("answer3"), userTurn("fourth")], {
        temperature: 0.9,
      }),
    },
    { name: "change tools", payload: chat(history, { tools: [{ name: "new" }] }) },
    {
      name: "change system prompt",
      payload: { messages: [{ role: "system", content: "new rules" }, ...history] },
    },
    {
      name: "edit and shorten while changing params and tools",
      payload: chat([userTurn("first"), assistantTurn("edited")], {
        temperature: 0.9,
        tools: [{ name: "new" }],
      }),
    },
    {
      name: "explicit id survives entirely replaced history and settings",
      explicit: true,
      payload: {
        messages: [{ role: "system", content: "replacement rules" }, userTurn("replacement")],
        conversation: "same",
        temperature: 0.9,
        tools: [{ name: "new" }],
      },
    },
  ];
  it.each(changedTurns)(
    "links routing and remember across $name",
    async ({ payload, explicit }) => {
      if (!db) return;
      const row = await fixture();
      const now = new Date("2026-09-29T12:00:00Z");
      const base = {
        ownerId: row.tenant.id,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        securityScope: "token-a",
        accessGrantId: "grant-a",
        policy: { ...policy, maxRecords: 100 },
        surface: "OPENAI_CHAT_COMPLETIONS",
      };
      await service.rememberAffinity({
        ...base,
        payload: chat(history, explicit ? { conversation: "same" } : {}),
        target: row.target(0),
        estimatedTokens: 20_000,
        now,
      });
      const before = await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
      });
      const [sessionId] = new Set(before.map((r) => r.sessionId));
      expect(sessionId).toBeTruthy();
      const later = new Date(now.getTime() + 1000);
      const ranked = await service.rankAffinityTargets({
        ...base,
        payload,
        targets: [row.target(0), row.target(1)],
        scoreSingleTarget: true,
        now: later,
      });
      expect(ranked.matchedSessionIds).toEqual({ [row.target(0).executionTargetId]: sessionId });
      const remember = () =>
        service.rememberAffinity({
          ...base,
          payload,
          target: row.target(0),
          estimatedTokens: 12_000,
          now: later,
          requestId: "later-turn",
        });
      await Promise.all([remember(), remember(), remember()]);
      const after = await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
      });
      expect(new Set(after.map((r) => r.sessionId))).toEqual(new Set([sessionId]));
      const warm = await import("./warm-protection.js");
      expect(
        (
          await warm.loadWarmSessions({
            ownerId: row.owner.id,
            capacityIds: [row.target(0).capacityId],
            policy: { windowSeconds: 300, minTokens: 8192 },
            now: later,
          })
        ).get(row.target(0).capacityId),
      ).toEqual([expect.objectContaining({ userId: row.tenant.id, ageMs: 0, tokens: 12_000 })]);
      // The same history on a different target is a distinct session even when
      // both execution targets point at the same capacity/KV pool.
      await service.rememberAffinity({ ...base, payload, target: row.target(1), now: later });
      const moved = await db.cacheAffinityRecord.findMany({
        where: {
          poolId: row.pool.id,
          executionTargetId: row.target(1).executionTargetId,
          prefixDigest: null,
        },
      });
      expect(moved.every((r) => r.sessionId !== sessionId)).toBe(true);
    },
  );

  it.each(["explicit", "implicit"] as const)(
    "preserves two %s conversations sharing all routing hints",
    async (kind) => {
      if (!db) return;
      const row = await fixture();
      const now = new Date("2026-09-29T12:00:00Z");
      const base = {
        ownerId: row.tenant.id,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy: { ...policy, maxRecords: 100 },
        surface: "OPENAI_CHAT_COMPLETIONS",
        target: row.target(0),
      };
      const payload = (id: string) =>
        chat(
          [userTurn("identical first message")],
          kind === "explicit" ? { conversation: id } : {},
        );
      await Promise.all(
        ["a", "b"].map((id) =>
          service.rememberAffinity({
            ...base,
            payload: payload(id),
            requestId: id,
            estimatedTokens: id === "a" ? 20_000 : 12_000,
            now,
          }),
        ),
      );
      const anchors = await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
      });
      const keys = new Set(anchors.map((r) => r.sessionId));
      expect(keys.size).toBe(2);
      const count = await db.cacheAffinityRecord.count({ where: { poolId: row.pool.id } });
      // Completion retries have a stable request identity, even for first turns.
      await Promise.all(
        ["a", "b"].map((id) =>
          service.rememberAffinity({
            ...base,
            payload: payload(id),
            requestId: id,
            now: new Date(now.getTime() - 1000),
          }),
        ),
      );
      expect(await db.cacheAffinityRecord.count({ where: { poolId: row.pool.id } })).toBe(count);
      const refreshed = await db.cacheAffinityRecord.findMany({ where: { poolId: row.pool.id } });
      expect(refreshed.every((r) => r.lastUsedAt.getTime() === now.getTime())).toBe(true);
      expect(
        refreshed.every((r) => r.expiresAt.getTime() === now.getTime() + policy.ttlSeconds * 1000),
      ).toBe(true);
      const ranked = await service.rankAffinityTargets({
        ...base,
        targets: [row.target(0)],
        scoreSingleTarget: true,
        payload: chat([
          userTurn("identical first message"),
          assistantTurn("different answer"),
          userTurn("next"),
        ]),
        now,
      });
      expect(ranked.matchedSessionIds).toEqual({});
      const warm = await import("./warm-protection.js");
      const sessions =
        (
          await warm.loadWarmSessions({
            ownerId: row.owner.id,
            capacityIds: [row.target(0).capacityId],
            policy: { windowSeconds: 300, minTokens: 8192 },
            now,
          })
        ).get(row.target(0).capacityId) ?? [];
      expect(sessions.map((s) => s.tokens).sort((a, b) => a - b)).toEqual([12_000, 20_000]);
      expect(sessions.map((s) => s.ageMs)).toEqual([0, 0]);
    },
  );

  it("updates one snapshot through edits, links its latest history, and forgets replaced prefixes", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    const original = chat(history, { conversation: "session-a" });
    await service.rememberAffinity({ ...base, payload: original, requestId: "original", now });
    const [first] = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null },
    });
    if (!first) throw new Error("missing snapshot");
    // An explicit id permits replacing the first turn; subsequent implicit
    // histories cannot borrow this explicit session, even when identical.
    const replaced = chat(
      [userTurn("new first"), assistantTurn("new answer"), userTurn("new tail")],
      {
        conversation: "session-a",
        temperature: 0.5,
      },
    );
    const later = new Date(now.getTime() + 1000);
    await service.rememberAffinity({
      ...base,
      payload: replaced,
      requestId: "replacement",
      now: later,
    });
    const [latest] = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null },
    });
    expect(latest?.id).toBe(first.id);
    expect(latest?.conversationDigest).toBe(first.conversationDigest);
    expect(latest?.historyDigests).toEqual(
      service.affinityPrefixDigests({
        ...base,
        payload: replaced,
        runtimeIdentity: row.target(0).targetIdentity,
      }).historyDigests,
    );
    // Last write identity makes retries a complete no-op, including future now.
    const unchanged = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id },
      orderBy: { id: "asc" },
    });
    await service.rememberAffinity({
      ...base,
      payload: replaced,
      requestId: "replacement",
      estimatedTokens: 99_000,
      now: new Date(now.getTime() + 2000),
    });
    expect(
      await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(unchanged);

    // Implicit session edits still link through a prefix of the LATEST row.
    const implicit = chat([
      userTurn("implicit first"),
      assistantTurn("old answer"),
      userTurn("old tail"),
    ]);
    await service.rememberAffinity({ ...base, payload: implicit, now });
    const [implicitFirst] = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null, explicitConversationDigest: null },
    });
    if (!implicitFirst) throw new Error("missing implicit snapshot");
    const edited = chat([
      userTurn("implicit first"),
      assistantTurn("edited answer"),
      userTurn("edited tail"),
    ]);
    await service.rememberAffinity({ ...base, payload: edited, now: later });
    const next = chat([...edited.messages, assistantTurn("answer"), userTurn("next")], {
      temperature: 0.9,
    });
    const rank = await service.rankAffinityTargets({
      ...base,
      payload: next,
      targets: [row.target(0)],
      scoreSingleTarget: true,
      now: later,
    });
    expect(rank.matchedSessionIds).toEqual({
      [row.target(0).executionTargetId]: implicitFirst.sessionId,
    });
    const [implicitLatest] = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null, explicitConversationDigest: null },
    });
    expect(implicitLatest?.id).toBe(implicitFirst.id);
    expect(implicitLatest?.historyDigests).not.toContain(implicitFirst.historyDigests[1]);
    // An unrelated second conversation cannot be merged on a shared system hint.
    const other = chat([
      userTurn("different conversation"),
      assistantTurn("answer"),
      userTurn("next"),
    ]);
    expect(
      (
        await service.rankAffinityTargets({
          ...base,
          payload: other,
          targets: [row.target(0)],
          scoreSingleTarget: true,
          now: later,
        })
      ).matchedSessionIds,
    ).toEqual({});
    await service.rememberAffinity({ ...base, payload: other, now: later });
    expect(
      await db.cacheAffinityRecord.count({ where: { poolId: row.pool.id, prefixDigest: null } }),
    ).toBe(3);
  });

  it("caps history and size samples at 64, refreshes sub-floor age, and rejects older completions", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    const payload = chat(
      Array.from({ length: 70 }, (_, turn) => ({
        role: turn % 2 === 0 ? "user" : "assistant",
        content: `turn ${turn}`,
      })),
      { conversation: "bounded" },
    );
    for (let turn = 0; turn < 66; turn += 1)
      await service.rememberAffinity({
        ...base,
        payload,
        requestId: `request-${turn}`,
        estimatedTokens: turn < 65 ? 20_065 - turn : 100,
        now: new Date(now.getTime() + turn * 10),
      });
    const snapshots = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.historyDigests).toHaveLength(64);
    expect(snapshots[0]?.sessionTokenEstimates).toHaveLength(64);
    expect(snapshots[0]?.sessionTokenTimes).toHaveLength(64);
    const warm = await import("./warm-protection.js");
    // Repeated equal sub-floor samples are dominated, so they cannot push out
    // the last eligible size even after more than 64 additional turns.
    for (let turn = 66; turn < 136; turn += 1)
      await service.rememberAffinity({
        ...base,
        payload,
        requestId: `request-${turn}`,
        estimatedTokens: 100,
        now: new Date(now.getTime() + turn * 10),
      });
    const latest = new Date(now.getTime() + 1350);
    expect(
      (
        await warm.loadWarmSessions({
          ownerId: row.owner.id,
          capacityIds: [row.target(0).capacityId],
          policy: { windowSeconds: 300, minTokens: 8192 },
          now: latest,
        })
      ).get(row.target(0).capacityId),
    ).toEqual([expect.objectContaining({ ageMs: 0, tokens: 20_001 })]);
    const before = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id },
      orderBy: { id: "asc" },
    });
    await service.rememberAffinity({
      ...base,
      payload,
      requestId: "delayed",
      estimatedTokens: 50_000,
      now,
    });
    expect(
      await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  }, 30_000);

  it("bulk hint writes preserve unreported evidence, clear reported misses, and keep newer hint clocks", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    const payload = chat(
      Array.from({ length: 40 }, (_, turn) => ({
        role: turn % 2 === 0 ? "user" : "assistant",
        content: `turn ${turn}`,
      })),
      { conversation: "a" },
    );
    const read = () =>
      db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id },
        orderBy: { id: "asc" },
      });
    await service.rememberAffinity({
      ...base,
      payload,
      estimatedTokens: 20_000,
      engineCacheConfirmed: true,
      now,
    });
    expect((await read()).every((record) => record.engineCacheConfirmed)).toBe(true);
    await service.rememberAffinity({ ...base, payload, now: new Date(now.getTime() + 1000) });
    expect(
      (await read()).every(
        (record) => record.engineCacheConfirmed && record.estimatedTokens === 20_000,
      ),
    ).toBe(true);
    const latest = new Date(now.getTime() + 2000);
    await service.rememberAffinity({
      ...base,
      payload,
      estimatedTokens: 12_000,
      engineCacheConfirmed: false,
      now: latest,
    });
    const before = await read();
    expect(before.filter((record) => record.prefixDigest === null)).toHaveLength(1);
    expect(
      before.every((record) => !record.engineCacheConfirmed && record.estimatedTokens === 12_000),
    ).toBe(true);
    // A delayed DIFFERENT explicit conversation cannot roll shared hints back,
    // even though it creates its own snapshot instead of using A's clock guard.
    await service.rememberAffinity({
      ...base,
      payload: { ...payload, conversation: "b" },
      estimatedTokens: 90_000,
      engineCacheConfirmed: true,
      now,
    });
    const after = await read();
    expect(after.filter((record) => record.prefixDigest !== null)).toEqual(
      before.filter((record) => record.prefixDigest !== null),
    );
    expect(after.filter((record) => record.prefixDigest === null)).toHaveLength(2);
    expect(
      new Set(
        after.filter((record) => record.prefixDigest === null).map((record) => record.sessionId),
      ).size,
    ).toBe(2);
  });

  it("keeps 5,000 seeded forty-turn sessions bounded after repeated writes and reads only matching rows", async () => {
    if (!db) return;
    const row = await fixture();
    // Freeze one clock for the entire workload. Keep it ahead of wall-clock
    // sweep tests sharing this database; every turn advances it explicitly.
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // 5,000 live sessions are seeded in bulk; a sample of them is rewritten through
    // the real completion path (each write is dozens of upserts: all 5,000 twice
    // would take many minutes without adding a distinct case).
    const sessionCount = 5000;
    const writtenSessions = 40;
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, ttlSeconds: 3600, maxRecords: 10_000 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    const payloads = Array.from({ length: sessionCount }, (_, session) =>
      chat(
        Array.from({ length: 40 }, (_, turn) => ({
          role: turn % 2 === 0 ? "user" : "assistant",
          content: `session ${session}, turn ${turn}`,
        })),
      ),
    );
    const materials = payloads.map((payload) =>
      service.affinityPrefixDigests({
        ...base,
        payload,
        runtimeIdentity: row.target(0).targetIdentity,
      }),
    );
    // Bulk seed realistic old snapshots to avoid 5,000 redundant initial routing
    // calls. Every session below then gets TWO different real rememberAffinity
    // completion writes with all 40 history units. The old per-request identity
    // would multiply the snapshot count and crowd this retention budget.
    for (let offset = 0; offset < sessionCount; offset += 250) {
      await db.cacheAffinityRecord.createMany({
        data: materials.slice(offset, offset + 250).map((material, index) => ({
          userId: row.owner.id,
          tenantUserId: row.tenant.id,
          poolId: row.pool.id,
          executionTargetId: row.target(0).executionTargetId,
          targetIdentity: row.target(0).targetIdentity,
          bindingDigest: material.bindingDigest,
          prefixDigest: null,
          prefixDepth: 0,
          sessionId: `scale-session-${offset + index}`,
          conversationDigest: hmacDigestForForwarderPurpose({
            purpose: "cacheAffinity",
            value: `affinity-session-snapshot-v1:scale-session-${offset + index}`,
          }),
          historyDigests: material.historyDigests,
          estimatedTokens: 20_000,
          sessionTokenEstimates: [20_000],
          sessionTokenTimes: [now],
          createdAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        })),
      });
    }
    await db.$executeRaw`ANALYZE cache_affinity_record`;
    const { default: prisma, Prisma } = await import("@ws-model-proxy/db");
    const fetchedRows = vi.fn<(count: number) => void>();
    const fetchedRawRows = vi.fn<(count: number) => void>();
    let lastHistoryQuery: PrismaTypes.Sql | undefined;
    const transact = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementation((fn, options) =>
      transact(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(client, property, receiver) {
                // Observe real results without replacing methods on Prisma's shared
                // proxy/prototype (restoring a bound transaction method can retain
                // a closed transaction when a routing read follows a write).
                if (property === "$queryRaw")
                  return async (
                    query: TemplateStringsArray | PrismaTypes.Sql,
                    ...values: unknown[]
                  ) => {
                    const rows = await client.$queryRaw(query, ...values);
                    fetchedRawRows(rowCount(rows));
                    if ("sql" in query) lastHistoryQuery = query;
                    return rows;
                  };
                if (property === "cacheAffinityRecord")
                  return new Proxy(client.cacheAffinityRecord, {
                    get(delegate, method, delegateReceiver) {
                      if (method === "findMany")
                        return async (args: PrismaTypes.CacheAffinityRecordFindManyArgs) => {
                          const rows = await delegate.findMany(args);
                          fetchedRows(rows.length);
                          return rows;
                        };
                      return Reflect.get(delegate, method, delegateReceiver);
                    },
                  });
                return Reflect.get(client, property, receiver);
              },
            }),
          ),
        options,
      ),
    );
    const rankSpy = vi.spyOn(prisma.cacheAffinityRecord, "findMany");
    try {
      for (let turn = 1; turn <= 2; turn += 1) {
        for (let session = 0; session < writtenSessions; session += 1) {
          await service.rememberAffinity({
            ...base,
            payload: { ...payloads[session], temperature: turn / 10 },
            requestId: `session-${session}-write-${turn}`,
            estimatedTokens: 12_000 + turn,
            now: new Date(now.getTime() + turn * 1000),
          });
        }
        expect(
          await db.cacheAffinityRecord.count({
            where: { poolId: row.pool.id, prefixDigest: null },
          }),
        ).toBe(sessionCount);
      }
      // Returned identity/hint rows and ordered-eviction ids stay independent of
      // population size. No test double replaces any SQL or Prisma result.
      expect(Math.max(...fetchedRows.mock.calls.map(([count]) => count))).toBeLessThanOrEqual(73);
      expect(fetchedRawRows.mock.calls.every(([count]) => count <= 2)).toBe(true);
      expect(
        await db.cacheAffinityRecord.count({ where: { poolId: row.pool.id } }),
      ).toBeLessThanOrEqual(10_000);
      const snapshots = await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
      });
      expect(snapshots.every((snapshot) => snapshot.historyDigests.length === 40)).toBe(true);
      expect(new Set(snapshots.map((snapshot) => snapshot.sessionId)).size).toBe(sessionCount);
      expect(
        snapshots
          .filter((snapshot) => Number(snapshot.sessionId?.split("-").at(-1)) < writtenSessions)
          .every((snapshot) => snapshot.sessionTokenTimes.length === 2),
      ).toBe(true);

      await db.$executeRaw`ANALYZE cache_affinity_record`;
      const columns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'cache_affinity_record'
           AND column_name IN ('historyDigests', 'explicitConversationDigest', 'writeDigest',
                               'sessionTokenEstimates', 'sessionTokenTimes')
      `;
      expect(columns).toHaveLength(5);
      expect(columns.every((column) => column.is_nullable === "YES")).toBe(true);

      const payload = chat(
        [...payloads[0]!.messages.slice(1, 35), userTurn("edited latest tail")],
        { temperature: 0.9, tools: [{ name: "changed-tool" }] },
      );
      const later = new Date(now.getTime() + 3000);
      fetchedRows.mockClear();
      fetchedRawRows.mockClear();
      rankSpy.mockClear();
      lastHistoryQuery = undefined;
      const rankStart = performance.now();
      const ranked = await service.rankAffinityTargets({
        ...base,
        payload,
        targets: [row.target(0)],
        scoreSingleTarget: true,
        now: later,
      });
      const rankMs = performance.now() - rankStart;
      expect(ranked.matchedSessionIds).toEqual({
        [row.target(0).executionTargetId]: "scale-session-0",
      });
      expect(rankSpy).toHaveBeenCalledTimes(1);
      expect(fetchedRawRows).toHaveBeenCalledTimes(2);
      const rankRowCounts = [
        ...(await Promise.all(
          rankSpy.mock.results.map(async (result) =>
            result.type === "return" ? rowCount(await result.value) : 0,
          ),
        )),
        ...fetchedRawRows.mock.calls.map(([count]) => count),
      ];
      expect(rankRowCounts.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(42);
      const historyQuery = lastHistoryQuery;
      if (!historyQuery) throw new Error("missing routing SQL");
      fetchedRows.mockClear();
      fetchedRawRows.mockClear();
      const rememberStart = performance.now();
      await service.rememberAffinity({ ...base, payload, requestId: "edited-latest", now: later });
      const rememberMs = performance.now() - rememberStart;
      expect(fetchedRows).toHaveBeenCalledTimes(3);
      expect(fetchedRawRows).toHaveBeenCalledTimes(3);
      expect(fetchedRawRows.mock.calls.every(([count]) => count <= 2)).toBe(true);
      expect(fetchedRows.mock.calls.every(([count]) => count <= 73)).toBe(true);
      expect(rankMs).toBeLessThan(500);
      expect(rememberMs).toBeLessThan(500);
      expect(
        await db.cacheAffinityRecord.count({
          where: { poolId: row.pool.id, prefixDigest: null },
        }),
      ).toBe(sessionCount);
      // Explain the actual successful routing query captured by the spy, not
      // a less selective approximation whose LIMIT can choose a different plan.
      const plan = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`EXPLAIN ${historyQuery}`);
      });
      expect(plan.map((part) => part["QUERY PLAN"]).join("\n")).toContain("historyDigests_idx");
      console.info(
        `[cache-affinity scale] sessions=${sessionCount}; rank=${rankMs.toFixed(1)}ms; remember=${rememberMs.toFixed(1)}ms; rank rows=${rankRowCounts.join(",")}; remember rows=${[...fetchedRows.mock.calls, ...fetchedRawRows.mock.calls].map(([count]) => count).join(",")}`,
      );

      // Inverse budget case: 5,000 independently owned sessions with identical
      // current histories must stay ambiguous while only TWO rows are fetched.
      const common = chat(
        Array.from({ length: 40 }, (_, turn) => ({
          role: turn % 2 === 0 ? "user" : "assistant",
          content: `common turn ${turn}`,
        })),
      );
      const commonMaterial = service.affinityPrefixDigests({
        ...base,
        payload: common,
        runtimeIdentity: row.target(0).targetIdentity,
      });
      await db.cacheAffinityRecord.updateMany({
        where: { poolId: row.pool.id, prefixDigest: null },
        data: { historyDigests: commonMaterial.historyDigests },
      });
      const ambiguous = chat([...common.messages, userTurn("continuation")]);
      rankSpy.mockClear();
      fetchedRows.mockClear();
      fetchedRawRows.mockClear();
      const ambiguousRank = await service.rankAffinityTargets({
        ...base,
        payload: ambiguous,
        targets: [row.target(0)],
        scoreSingleTarget: true,
        now: later,
      });
      expect(ambiguousRank.matchedSessionIds).toEqual({});
      const ambiguousRowCounts = [
        ...(await Promise.all(
          rankSpy.mock.results.map(async (result) =>
            result.type === "return" ? rowCount(await result.value) : 0,
          ),
        )),
        ...fetchedRawRows.mock.calls.map(([count]) => count),
      ];
      expect(ambiguousRowCounts.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(3);
      expect(ambiguousRowCounts).toContain(2);
      await service.rememberAffinity({
        ...base,
        payload: ambiguous,
        requestId: "ambiguous",
        now: later,
      });
      expect(
        await db.cacheAffinityRecord.count({ where: { poolId: row.pool.id, prefixDigest: null } }),
      ).toBe(sessionCount + 1);
      expect(fetchedRows.mock.calls.every(([count]) => count <= 73)).toBe(true);
    } finally {
      rankSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  }, 300_000);

  it.each(["tenant", "token", "grant", "runtime", "pool", "version", "expiry"] as const)(
    "never links or writes across %s scope",
    async (scope) => {
      if (!db) return;
      const row = await fixture();
      const now = new Date("2026-09-29T12:00:00Z");
      const base = {
        ownerId: row.tenant.id,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        securityScope: "token-a",
        accessGrantId: "grant-a",
        policy: { ...policy, maxRecords: 100 },
        surface: "OPENAI_CHAT_COMPLETIONS",
      };
      const original = chat([userTurn("first")]);
      await service.rememberAffinity({ ...base, payload: original, target: row.target(0), now });
      const [old] = await db.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
      });
      if (!old) throw new Error("missing snapshot");
      let changed = { ...base };
      let target = row.target(0);
      if (scope === "tenant") changed.ownerId = row.otherTenant.id;
      if (scope === "token") changed.securityScope = "token-b";
      if (scope === "grant") changed.accessGrantId = "grant-b";
      if (scope === "runtime") target = { ...target, targetIdentity: "replacement" };
      if (scope === "pool")
        changed.poolId = (
          await db.modelPool.create({
            data: { userId: row.owner.id, slug: crypto.randomUUID(), name: "Other" },
          })
        ).id;
      if (scope === "expiry")
        await db.cacheAffinityRecord.updateMany({
          where: { poolId: row.pool.id },
          data: { expiresAt: new Date(now.getTime() + 500) },
        });
      if (scope === "version") {
        // Identity is immutable: recreate the fixture with a supported legacy version.
        const records = await db.cacheAffinityRecord.findMany({ where: { poolId: row.pool.id } });
        await db.cacheAffinityRecord.deleteMany({ where: { poolId: row.pool.id } });
        await db.cacheAffinityRecord.createMany({
          data: records.map((r) => ({
            ...r,
            digestVersion: 3,
          })),
        });
      }
      const payload = chat([userTurn("first"), assistantTurn("answer"), userTurn("second")]);
      const later = new Date(now.getTime() + 1000);
      const ranked = await service.rankAffinityTargets({
        ...changed,
        payload,
        targets: [target],
        scoreSingleTarget: true,
        now: later,
      });
      expect(ranked.matchedSessionIds).toEqual({});
      await service.rememberAffinity({ ...changed, payload, target, now: later });
      const anchors = await db.cacheAffinityRecord.findMany({
        where: {
          tenantUserId: changed.ownerId,
          poolId: changed.poolId,
          targetIdentity: target.targetIdentity,
          prefixDigest: null,
          lastUsedAt: later,
        },
      });
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.sessionId).not.toBe(old.sessionId);
    },
  );

  it("never merges an unseen explicit continuation with an existing conversation", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    await service.rememberAffinity({
      ...base,
      payload: chat(history, { conversation: "a" }),
      estimatedTokens: 20_000,
      now,
    });
    const payload = chat(history, { conversation: "b" });
    const ranked = await service.rankAffinityTargets({
      ...base,
      payload,
      targets: [row.target(0)],
      scoreSingleTarget: true,
      now,
    });
    expect(ranked.matchedSessionIds).toEqual({});
    await service.rememberAffinity({ ...base, payload, estimatedTokens: 12_000, now });
    const snapshots = await db.cacheAffinityRecord.findMany({
      where: { poolId: row.pool.id, prefixDigest: null },
    });
    expect(new Set(snapshots.map((r) => r.sessionId)).size).toBe(2);
  });

  it("adopts a legacy row id once and creates a durable continuation snapshot", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
    };
    const material = service.affinityPrefixDigests({
      ...base,
      payload: chat([userTurn("legacy")]),
      runtimeIdentity: row.target(0).targetIdentity,
    });
    const legacy = await db.cacheAffinityRecord.create({
      data: {
        userId: row.owner.id,
        tenantUserId: row.tenant.id,
        poolId: row.pool.id,
        executionTargetId: row.target(0).executionTargetId,
        targetIdentity: row.target(0).targetIdentity,
        bindingDigest: material.bindingDigest,
        prefixDigest: material.digests[0],
        prefixDepth: 1,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        estimatedTokens: 20_000,
      },
    });
    const payload = chat([userTurn("legacy"), assistantTurn("answer"), userTurn("next")]);
    const later = new Date(now.getTime() + 1000);
    const ranked = await service.rankAffinityTargets({
      ...base,
      payload,
      targets: [row.target(0)],
      scoreSingleTarget: true,
      now: later,
    });
    expect(ranked.matchedSessionIds).toEqual({ [row.target(0).executionTargetId]: legacy.id });
    await service.rememberAffinity({
      ...base,
      payload,
      target: row.target(0),
      estimatedTokens: 12_000,
      now: later,
    });
    const warm = await import("./warm-protection.js");
    expect(
      (
        await warm.loadWarmSessions({
          ownerId: row.owner.id,
          capacityIds: [row.target(0).capacityId],
          policy: { windowSeconds: 300, minTokens: 8192 },
          now: later,
        })
      ).get(row.target(0).capacityId),
    ).toEqual([expect.objectContaining({ ageMs: 0, tokens: 12_000 })]);
    const paramsChanged = await service.rankAffinityTargets({
      ...base,
      payload: { ...payload, temperature: 0.9 },
      targets: [row.target(0)],
      scoreSingleTarget: true,
      now: later,
    });
    expect(paramsChanged.matchedSessionIds).toEqual(ranked.matchedSessionIds);
  });

  it("instruction-only refreshes cannot create warmth or refresh another session", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      target: row.target(0),
    };
    const warm = await import("./warm-protection.js");
    const read = async (now: Date) =>
      (
        await warm.loadWarmSessions({
          ownerId: row.owner.id,
          capacityIds: [row.target(0).capacityId],
          policy: { windowSeconds: 300, minTokens: 8192 },
          now,
        })
      ).get(row.target(0).capacityId) ?? [];
    await service.rememberAffinity({ ...base, payload: chat([]), estimatedTokens: 90_000, now });
    expect(await read(now)).toEqual([]);
    await service.rememberAffinity({
      ...base,
      payload: chat([userTurn("different first")]),
      estimatedTokens: 20_000,
      now,
    });
    const later = new Date(now.getTime() + 1000);
    await service.rememberAffinity({
      ...base,
      payload: chat([]),
      estimatedTokens: 90_000,
      now: later,
    });
    expect(await read(later)).toEqual([expect.objectContaining({ ageMs: 1000, tokens: 20_000 })]);
  });

  it("keeps the session snapshot when the row bound is one", async () => {
    if (!db) return;
    const row = await fixture();
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, maxRecords: 1 },
      surface: "OPENAI_CHAT_COMPLETIONS",
    };
    const payload = chat(history, { conversation: "explicit" });
    await service.rememberAffinity({ ...base, payload, target: row.target(0), now });
    const records = await db.cacheAffinityRecord.findMany({ where: { poolId: row.pool.id } });
    expect(records).toHaveLength(1);
    expect(records[0]?.prefixDigest).toBeNull();
    const ranked = await service.rankAffinityTargets({
      ...base,
      payload: chat([userTurn("fully changed")], { conversation: "explicit", temperature: 0.8 }),
      targets: [row.target(0)],
      scoreSingleTarget: true,
      now,
    });
    expect(ranked.matchedSessionIds).toEqual({
      [row.target(0).executionTargetId]: records[0]?.sessionId,
    });
  });

  it("persists one bounded conversation-only record under concurrent refreshes", async () => {
    if (!db) return;
    const row = await fixture();
    const args = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "grant:token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation-only" },
      target: row.target(0),
    };
    await Promise.all(Array.from({ length: 8 }, () => service.rememberAffinity(args)));
    const records = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
      select: {
        prefixDigest: true,
        conversationDigest: true,
        prefixDepth: true,
        digestVersion: true,
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ prefixDigest: null, prefixDepth: 0, digestVersion: 4 });
    expect(records[0]?.conversationDigest).toHaveLength(43);
  });

  it("serializes concurrent remembers and enforces a bound independently per target and tenant", async () => {
    if (!db) return;
    const row = await fixture();
    const remember = (tenantUserId: string, targetIndex: number, value: string) =>
      service.rememberAffinity({
        ownerId: tenantUserId,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: value },
        target: row.target(targetIndex),
      });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        remember(row.tenant.id, index % 2, `tenant request ${index}`),
      ),
    );
    await Promise.all([
      remember(row.otherTenant.id, 0, "isolated one"),
      remember(row.otherTenant.id, 0, "isolated two"),
    ]);
    const grouped = await db.cacheAffinityRecord.groupBy({
      by: ["tenantUserId", "executionTargetId"],
      where: { poolId: row.pool.id },
      _count: { _all: true },
    });
    expect(grouped.find((entry) => entry.tenantUserId === row.tenant.id)?._count._all).toBe(3);
    expect(grouped.filter((entry) => entry.tenantUserId === row.tenant.id)).toHaveLength(2);
    expect(grouped.find((entry) => entry.tenantUserId === row.otherTenant.id)?._count._all).toBe(3);
  });

  it("makes cleanup idempotent and safe against a concurrent refresh", async () => {
    if (!db) return;
    const row = await fixture();
    const args = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, ttlSeconds: 1 },
      surface: "OPENAI_RESPONSES",
      payload: { input: "same request" },
      target: row.target(0),
    };
    await service.rememberAffinity(args);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await Promise.all([
      service.sweepExpiredAffinity({ now: new Date(), limit: 1 }),
      service.rememberAffinity({ ...args, policy, now: new Date() }),
    ]);
    expect(
      await db.cacheAffinityRecord.count({
        where: { tenantUserId: row.tenant.id, poolId: row.pool.id, expiresAt: { gt: new Date() } },
      }),
    ).toBe(2);
    let swept = 1;
    for (let attempt = 0; attempt < 100 && swept > 0; attempt += 1) {
      swept = await service.sweepExpiredAffinity({ now: new Date(), limit: 10 });
    }
    expect(swept).toBe(0);
    expect(await service.sweepExpiredAffinity({ now: new Date(), limit: 1 })).toBe(0);
  });

  it("looks up identity after acquiring the cache-affinity fence", async () => {
    if (!db || !databaseUrl) return;
    const row = await fixture();
    const blocker = createFixturePrismaClient(databaseUrl);
    const now = new Date("2026-09-29T12:00:00Z");
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
    };
    const material = service.affinityPrefixDigests({
      ...base,
      payload: chat([userTurn("blocked")]),
      runtimeIdentity: row.target(0).targetIdentity,
    });
    let releaseLock!: () => void;
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = blocker.$transaction(async (tx) => {
      // The fence the writer (and the dashboard clear) takes; under DL-1 (d)
      // affinity writes lock no graph row.
      await acquireFences(tx, [fences.cacheAffinity(row.owner.id, row.pool.id)]);
      signalLockAcquired();
      await release;
      // This evidence becomes visible only after the waiting writer gets the
      // fence. A lookup before locking would mint a second session.
      await tx.cacheAffinityRecord.create({
        data: {
          userId: row.owner.id,
          tenantUserId: row.tenant.id,
          poolId: row.pool.id,
          executionTargetId: row.target(0).executionTargetId,
          targetIdentity: row.target(0).targetIdentity,
          bindingDigest: material.bindingDigest,
          prefixDigest: null,
          conversationDigest: hmacDigestForForwarderPurpose({
            purpose: "cacheAffinity",
            value: "affinity-session-snapshot-v1:published-under-lock",
          }),
          prefixDepth: 0,
          sessionId: "published-under-lock",
          historyDigests: material.historyDigests,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      });
    });
    await lockAcquired;
    let settled = false;
    const remembering = service
      .rememberAffinity({
        ...base,
        payload: chat([userTurn("blocked"), assistantTurn("answer"), userTurn("next")]),
        target: row.target(0),
        now,
      })
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      releaseLock();
      await Promise.all([lock, remembering]);
      const records = await db.cacheAffinityRecord.findMany({ where: { poolId: row.pool.id } });
      expect(records.length).toBeGreaterThan(1);
      expect(records.every((r) => r.sessionId === "published-under-lock")).toBe(true);
    } finally {
      releaseLock();
      await Promise.allSettled([lock, remembering]);
      await blocker.$disconnect();
    }
  });
});

import type { Prisma as PrismaTypes } from "@ws-model-proxy/db";
