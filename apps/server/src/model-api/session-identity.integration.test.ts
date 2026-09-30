// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
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

integration("scoped warm-session identity regressions", () => {
  const db = databaseUrl ? createFixturePrismaClient(databaseUrl) : undefined;
  let service: typeof import("./cache-affinity.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= crypto.randomUUID();
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    service = await import("./cache-affinity.js");
  });

  afterAll(async () => db?.$disconnect());

  const fixtureUserIds: string[] = [];
  afterEach(async () => {
    if (!db) return;
    for (const id of fixtureUserIds.splice(0)) {
      await db.capacityLease.deleteMany({ where: { userId: id } });
      await db.user.deleteMany({ where: { id } });
    }
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

  const policy = {
    enabled: true,
    ttlSeconds: 60,
    maxRecords: 3,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };

  const warmPolicy = {
    enabled: true,
    windowSeconds: 300,
    minTokens: 1,
    share: "FIRST_COME" as const,
    fixedPercent: null,
  };
  const start = Date.now() + 1000;
  const at = (seconds: number) => new Date(start + seconds * 1000);
  const user = (content: string) => ({ role: "user", content });
  const assistant = (content: string) => ({ role: "assistant", content });
  const chat = (system: string, messages: unknown[]) => ({
    messages: [{ role: "system", content: system }, ...messages],
  });

  async function harness(surface = "OPENAI_CHAT_COMPLETIONS") {
    const row = await fixture();
    const base = {
      ownerId: row.owner.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      policy: { ...policy, ttlSeconds: 3600, maxRecords: 1000 },
      surface,
    };
    const remember = (
      payload: Record<string, unknown>,
      seconds: number,
      options: {
        requestId?: string;
        estimatedTokens?: number | null;
        target?: number;
        sessionBinding?: import("./cache-affinity.js").AffinitySessionBinding;
        securityScope?: string;
        targetIdentity?: string;
      } = {},
    ) =>
      service.rememberAffinity({
        ...base,
        payload,
        target: {
          ...row.target(options.target ?? 0),
          ...(options.targetIdentity ? { targetIdentity: options.targetIdentity } : {}),
        },
        sessionBinding: options.sessionBinding,
        securityScope: options.securityScope ?? base.securityScope,
        estimatedTokens:
          options.estimatedTokens === null ? undefined : (options.estimatedTokens ?? 20_000),
        requestId: options.requestId ?? `req-${seconds}`,
        now: at(seconds),
      });
    const rank = (payload: Record<string, unknown>, seconds: number) =>
      service.rankAffinityTargets({
        ...base,
        payload,
        targets: [row.target(0)],
        scoreSingleTarget: true,
        now: at(seconds),
      });
    const snapshots = () =>
      db!.cacheAffinityRecord.findMany({
        where: { poolId: row.pool.id, prefixDigest: null },
        orderBy: { lastUsedAt: "asc" },
      });
    const warm = async (seconds: number, windowSeconds = 300) =>
      (
        await (
          await import("./warm-protection.js")
        ).loadWarmSessions({
          ownerId: row.owner.id,
          capacityIds: [row.target(0).capacityId],
          policy: { ...warmPolicy, windowSeconds },
          now: at(seconds),
        })
      ).get(row.target(0).capacityId) ?? [];
    let fencing = 0n;
    const lease = async (
      ids: string[],
      seconds: number,
      target = 0,
      state: "ACTIVE" | "RELEASED" = "ACTIVE",
      expiresInSeconds = 30,
    ) => {
      const id = crypto.randomUUID();
      fencing += 1n;
      const request = await db!.admissionRequest.create({
        data: {
          userId: row.owner.id,
          requestId: id,
          attemptId: id,
          sourceKind: "DIRECT",
          directExecutionTargetId: row.target(target).executionTargetId,
          basePriority: 16,
          enqueueSequence: fencing,
          connectionOwner: "test",
          heartbeatAt: at(seconds),
          state: "ADMITTED",
          warmSessionIds: ids,
        },
      });
      return db!.capacityLease.create({
        data: {
          userId: row.owner.id,
          admissionRequestId: request.id,
          requestId: id,
          attemptId: id,
          capacityId: row.target(target).capacityId,
          executionTargetId: row.target(target).executionTargetId,
          priority: 16,
          reservationClass: 0,
          fencingToken: fencing,
          state,
          ownerServerInstance: "test",
          acquiredAt: at(seconds - 60),
          heartbeatAt: at(seconds + Math.min(0, expiresInSeconds) - 1),
          expiresAt: at(seconds + expiresInSeconds),
          releasedAt: state === "RELEASED" ? at(seconds) : null,
          releaseReason: state === "RELEASED" ? "cancelled" : null,
        },
      });
    };
    return { row, base, remember, rank, snapshots, warm, lease };
  }

  const first = chat("rules", [user("same first")]);
  const x = chat("rules", [user("same first"), assistant("x1"), user("x2")]);
  const y = chat("rules", [user("same first"), assistant("y1"), user("y2")]);
  const cases: {
    name: string;
    seeds: Record<string, unknown>[];
    incoming: Record<string, unknown>;
    linkedSeed: number | null;
    count: number;
  }[] = [
    {
      name: "probe A: repeated first message selects contained Y over divergent X",
      seeds: [first, x, first],
      incoming: y,
      linkedSeed: 2,
      count: 2,
    },
    {
      name: "probe B: different instructions cannot merge X with imported Z",
      seeds: [first, x],
      incoming: chat("different rules", [user("same first"), assistant("z1"), user("z2")]),
      linkedSeed: null,
      count: 2,
    },
    {
      name: "different tools cannot merge a conversation sharing the entire history",
      seeds: [first, x],
      incoming: { ...x, tools: [{ name: "new" }] },
      linkedSeed: null,
      count: 2,
    },
    {
      name: "sampling-only change retains the contained Y tie preference without cache affinity",
      seeds: [first, x, first],
      incoming: { ...y, temperature: 0.9 },
      linkedSeed: 2,
      count: 2,
    },
    {
      name: "contained Y is found beyond the old two-row read bound",
      seeds: [
        first,
        x,
        first,
        chat("rules", [user("same first"), assistant("z1"), user("z2")]),
        first,
        chat("rules", [user("same first"), assistant("w1"), user("w2")]),
        first,
      ],
      incoming: y,
      linkedSeed: 6,
      count: 4,
    },
    {
      name: "stronger cache prefix of a different session rejects a weaker history identity",
      seeds: [
        first,
        x,
        chat("rules", [user("same first"), assistant("x1")]),
        { ...x, conversation: "different" },
      ],
      incoming: x,
      linkedSeed: null,
      count: 3,
    },
    // Residuals/inverse checks intentionally pass on the old code: preserve
    // explicit/fresh isolation and legitimate edits, and pin indistinguishable inputs.
    {
      name: "same-instruction imported first-message overlap is indistinguishable from an edit",
      seeds: [first, x],
      incoming: y,
      linkedSeed: 1,
      count: 1,
    },
    {
      name: "two contained starters remain ambiguous despite recency",
      seeds: [first, first],
      incoming: y,
      linkedSeed: null,
      count: 3,
    },
    {
      name: "an edit of X is indistinguishable from a continuation of contained Y",
      seeds: [first, x, first],
      incoming: chat("rules", [user("same first"), assistant("edited")]),
      linkedSeed: 2,
      count: 2,
    },
    {
      name: "deeper shared edited history beats a shallower contained starter",
      seeds: [first, x, first],
      incoming: chat("rules", [user("same first"), assistant("x1"), user("edited")]),
      linkedSeed: 1,
      count: 2,
    },
    {
      name: "params-only shortening still links the unique deeper history",
      seeds: [first, x],
      incoming: { ...chat("rules", [user("same first"), assistant("x1")]), temperature: 0.7 },
      linkedSeed: 1,
      count: 1,
    },
    {
      name: "fresh identical first messages remain separate",
      seeds: [first],
      incoming: first,
      linkedSeed: null,
      count: 2,
    },
    {
      name: "explicit id survives full instruction tool and history replacement",
      seeds: [{ ...first, conversation: "explicit" }],
      incoming: {
        ...chat("replacement", [user("replacement")]),
        tools: [{ name: "new" }],
        conversation: "explicit",
      },
      linkedSeed: 0,
      count: 1,
    },
    {
      name: "unseen explicit id cannot steal a contained implicit session",
      seeds: [first],
      incoming: { ...y, conversation: "new-explicit" },
      linkedSeed: null,
      count: 2,
    },
  ];
  it.each(cases)("$name", async ({ seeds, incoming, linkedSeed, count }) => {
    const h = await harness();
    const seeded: string[] = [];
    for (const [index, payload] of seeds.entries()) {
      await h.remember(payload, index + 1);
      const snapshot = (await h.snapshots()).find(
        ({ lastUsedAt }) => lastUsedAt.getTime() === at(index + 1).getTime(),
      );
      expect(snapshot?.sessionId).toBeTruthy();
      seeded.push(snapshot!.sessionId!);
    }
    const before = await h.snapshots();
    const seconds = seeds.length + 1;
    const ranked = await h.rank(incoming, seconds);
    const expected = linkedSeed === null ? undefined : seeded[linkedSeed];
    expect(ranked.matchedSessionIds).toEqual(
      expected ? { [h.row.target(0).executionTargetId]: expected } : {},
    );
    await h.lease(Object.values(ranked.matchedSessionIds ?? {}), seconds);
    const during = await h.warm(seconds);
    expect(during.filter(({ inFlight }) => inFlight).map(({ sessionId }) => sessionId)).toEqual(
      expected ? [expected] : [],
    );
    await h.remember(incoming, seconds);
    const after = await h.snapshots();
    expect(after).toHaveLength(count);
    for (const victim of before.filter(({ sessionId }) => sessionId !== expected)) {
      expect(after.find(({ id }) => id === victim.id)).toEqual(victim);
    }
    expect(await h.warm(seconds + 1)).toHaveLength(count);
    // Same successful completion replay must not add a session or refresh any clock.
    await h.remember(incoming, seconds + 2, { requestId: `req-${seconds}` });
    expect(await h.snapshots()).toEqual(after);
  });

  it.each([
    {
      name: "active selected target",
      state: "ACTIVE" as const,
      expiry: 30,
      target: 0,
      flight: [true, false],
    },
    {
      name: "active alternate target",
      state: "ACTIVE" as const,
      expiry: 30,
      target: 1,
      flight: [false, true],
    },
    {
      name: "cancelled lease",
      state: "RELEASED" as const,
      expiry: 30,
      target: 0,
      flight: [false, false],
    },
    {
      name: "expired lease",
      state: "ACTIVE" as const,
      expiry: -1,
      target: 0,
      flight: [false, false],
    },
  ])("in-flight scope: $name", async ({ state, expiry, target, flight }) => {
    const h = await harness();
    await h.remember(x, 1);
    await h.remember(x, 2, { target: 1 });
    const snapshots = await h.snapshots();
    // Adversarial alias: even the same id cannot cross execution targets.
    const sameId = snapshots[0]!.sessionId!;
    await db!.cacheAffinityRecord.update({
      where: { id: snapshots[1]!.id },
      data: { sessionId: sameId },
    });
    await h.lease([sameId], 3, target, state, expiry);
    const sessions = await h.warm(3);
    for (const index of [0, 1]) {
      expect(
        sessions.find(
          ({ executionTargetId }) => executionTargetId === h.row.target(index).executionTargetId,
        )?.inFlight,
      ).toBe(flight[index]);
    }
  });

  it.each([
    { name: "expired eligible size", refresh: 3602, window: 300, count: 0 },
    { name: "size inside window", refresh: 2, window: 300, count: 1 },
    { name: "size inside TTL but outside window", refresh: 302, window: 300, count: 0 },
  ])("unknown latest estimate: $name", async ({ refresh, window, count }) => {
    const h = await harness();
    const payload = { ...first, conversation: "same" };
    await h.remember(payload, 1);
    if (refresh > 3600) await h.remember(payload, 2000, { estimatedTokens: null });
    await h.remember(payload, refresh, { estimatedTokens: null });
    expect(await h.warm(refresh + 1, window)).toHaveLength(count);
    const newest = (await h.snapshots()).at(-1)!;
    expect(newest.estimatedTokens).toBeNull();
  });

  it.each(["implicit", "explicit"])(
    "older %s completion replay survives a successor turn",
    async (kind) => {
      const h = await harness();
      const initial = kind === "explicit" ? { ...first, conversation: "same" } : first;
      const next = kind === "explicit" ? { ...x, conversation: "same" } : x;
      await h.remember(initial, 1, { requestId: "initial" });
      await h.remember(next, 2, { requestId: "successor" });
      const before = await db!.cacheAffinityRecord.findMany({
        where: { poolId: h.row.pool.id },
        orderBy: { id: "asc" },
      });
      await h.remember(initial, 1, { requestId: "initial" });
      // Changed replay clocks must also be ignored, including TTL and routing hints.
      await h.remember(initial, 3, { requestId: "initial" });
      expect(
        await db!.cacheAffinityRecord.findMany({
          where: { poolId: h.row.pool.id },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      expect(await h.warm(3)).toHaveLength(1);
      expect((await h.snapshots())[0]!.completedWriteDigests).toHaveLength(2);
      if (kind === "implicit") {
        await h.remember(initial, 4, { requestId: "independent-first" });
        expect(await h.snapshots()).toHaveLength(2);
      }
    },
  );

  it("completion HMAC retention stays bounded while latest retries remain idempotent", async () => {
    const h = await harness();
    const payload = { ...first, conversation: "same" };
    for (let turn = 1; turn <= 66; turn++) await h.remember(payload, turn);
    const before = await h.snapshots();
    expect(before).toHaveLength(1);
    expect(before[0]!.completedWriteDigests).toHaveLength(64);
    expect(
      before[0]!.completedWriteDigests.every((digest) => /^[A-Za-z0-9_-]{43}$/.test(digest)),
    ).toBe(true);
    await h.remember(payload, 67, { requestId: "req-3" });
    expect(await h.snapshots()).toEqual(before);
  });

  it.each([
    { name: "implicit origin", explicit: false, mismatch: false },
    { name: "explicit origin", explicit: true, mismatch: false },
    { name: "another token", explicit: false, mismatch: true, securityScope: "token-b" },
    {
      name: "successor runtime",
      explicit: false,
      mismatch: true,
      targetIdentity: "successor-runtime",
    },
    {
      name: "missing binding defaults to a fresh session",
      explicit: false,
      mismatch: true,
      missing: true,
    },
  ])(
    "native Responses durable binding: $name",
    async ({ explicit, mismatch, securityScope, targetIdentity, missing }) => {
      const h = await harness("OPENAI_RESPONSES");
      const initial = {
        input: "first",
        instructions: "rules",
        ...(explicit ? { conversation: "explicit" } : {}),
      };
      const binding = await h.remember(initial, 1);
      expect(binding?.sessionId).toBeTruthy();
      const before = (await h.snapshots())[0]!;
      const incoming = {
        input: "next",
        instructions: "changed",
        previous_response_id: "response-id",
      };
      const next = await h.remember(incoming, 2, {
        sessionBinding: missing ? undefined : binding!,
        securityScope,
        targetIdentity,
      });
      expect(next?.sessionId === binding?.sessionId).toBe(!mismatch);
      expect(await h.snapshots()).toHaveLength(mismatch ? 2 : 1);
      if (!mismatch) {
        expect((await h.snapshots())[0]!.explicitConversationDigest).toBe(
          before.explicitConversationDigest,
        );
        // A bound completion retry retains the origin's explicit ownership even
        // though the native follow-up payload omits the conversation id.
        const snapshots = await h.snapshots();
        await h.remember(incoming, 3, { sessionBinding: binding!, requestId: "req-2" });
        expect(await h.snapshots()).toEqual(snapshots);
      } else expect((await h.snapshots()).find(({ id }) => id === before.id)).toEqual(before);
    },
  );

  it.each([
    { links: 0, state: "PROTECTED", idle: 2 },
    { links: 1, state: "FREE", idle: 1 },
    { links: 2, state: "FREE", idle: 0 },
  ])(
    "native Responses C=4 a=2 with $links linked continuations: $state",
    async ({ links, state, idle }) => {
      const h = await harness("OPENAI_RESPONSES");
      const bindings = [
        await h.remember({ input: "first A" }, 1),
        await h.remember({ input: "first B" }, 2),
      ];
      for (const [index, binding] of bindings.entries()) {
        await h.remember({ input: "next", previous_response_id: `response-${index}` }, 3 + index, {
          sessionBinding: binding!,
        });
        await h.lease(index < links ? [binding!.sessionId] : [], 5);
      }
      expect(await h.snapshots()).toHaveLength(2);
      const warm = await import("./warm-protection.js");
      const verdicts = await warm.assessWarmProtection({
        ownerId: h.row.owner.id,
        policy: warmPolicy,
        members: [
          {
            poolMemberId: "member",
            capacityId: h.row.target(0).capacityId,
            slots: 4,
            kvBudgetTokens: null,
            affine: false,
            requestTokens: 1,
          },
        ],
        // Read real leases and warm rows at the same controlled clock.
        source: {
          load: async () => ({
            activeByCapacity: new Map([
              [
                h.row.target(0).capacityId,
                await db!.capacityLease.count({
                  where: {
                    capacityId: h.row.target(0).capacityId,
                    state: "ACTIVE",
                    expiresAt: { gt: at(6) },
                  },
                }),
              ],
            ]),
            sessionsByCapacity: new Map([[h.row.target(0).capacityId, await h.warm(6)]]),
          }),
        },
      });
      const snapshot = await h.warm(6);
      expect(snapshot.filter(({ inFlight }) => !inFlight)).toHaveLength(idle);
      expect(verdicts.get("member")?.state).toBe(state);
      expect(verdicts.get("member")?.idleProtectedSessions).toBe(idle);
    },
  );

  it.each(["rollback", "conflicting concurrent retries"])(
    "durable identity state: %s",
    async (state) => {
      const h = await harness();
      const payload = { ...first, conversation: "same" };
      if (state === "rollback") {
        const { default: prisma } = await import("@ws-model-proxy/db");
        const transact = prisma.$transaction.bind(prisma);
        const spy = vi.spyOn(prisma, "$transaction").mockImplementation((fn, options) =>
          transact(async (tx) => {
            await fn(tx);
            throw new Error("injected precommit failure");
          }, options),
        );
        try {
          await expect(h.remember(payload, 1)).rejects.toThrow("injected precommit failure");
        } finally {
          spy.mockRestore();
        }
        expect(await db!.cacheAffinityRecord.count({ where: { poolId: h.row.pool.id } })).toBe(0);
      }
      await Promise.all(Array.from({ length: 3 }, () => h.remember(payload, 1)));
      const after = await h.snapshots();
      expect(after).toHaveLength(1);
      await h.remember(payload, 2, { requestId: "req-1" });
      expect(await h.snapshots()).toEqual(after);
    },
  );
});
