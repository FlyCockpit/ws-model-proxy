import type { Prisma } from "@ws-model-proxy/db";
// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  canonicalPayloadWire,
  depthPayloadWire,
  depthRows,
  instructionPlacementRows,
  numericOverflowPayload,
  numericOverflowRows,
  orderedHistoryPayload,
} from "./cache-affinity-canonical.test-fixtures.js";
import { MAX_CANONICAL_DEPTH } from "./cache-affinity-layers.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[cache-affinity] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("cache-prefix identity #160", () => {
  const db = databaseUrl ? createFixturePrismaClient(databaseUrl) : undefined;
  let warm: typeof import("./warm-protection.js");
  let service: typeof import("./cache-affinity.js");
  let producer: typeof import("@ws-model-proxy/db").default;

  const fixtureOwnerIds = new Set<string>();
  const testOwnerIds = new Set<string>();
  afterEach(async () => {
    if (!db || testOwnerIds.size === 0) return;
    const where = { userId: { in: [...testOwnerIds] } };
    await db.cacheAffinityNode.deleteMany({ where });
    await db.cacheAffinityRecord.deleteMany({ where });
    testOwnerIds.clear();
  });

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "cache-affinity-integration-secret-32-bytes";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    service = await import("./cache-affinity.js");
    warm = await import("./warm-protection.js");
    producer = (await import("@ws-model-proxy/db")).default;
  });

  afterAll(async () => {
    try {
      if (db && fixtureOwnerIds.size) {
        const where = { userId: { in: [...fixtureOwnerIds] } };
        await db.cacheAffinityNode.deleteMany({ where });
        await db.cacheAffinityRecord.deleteMany({ where });
      }
    } finally {
      await producer?.$disconnect();
      await db?.$disconnect();
    }
  });

  async function fixture() {
    if (!db) throw new Error("database unavailable");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Affinity owner", email: `affinity-owner-${suffix}@example.test` },
    });
    fixtureOwnerIds.add(owner.id);
    testOwnerIds.add(owner.id);
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
    maxRecords: 1000,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };

  const u = (content: string) => ({ role: "user", content });
  const a = (content: string) => ({ role: "assistant", content });
  const baseHistory = [u("shared starter"), a("reply"), u("next")];
  const argsFor = (row: Awaited<ReturnType<typeof fixture>>) => ({
    ownerId: row.tenant.id,
    resourceOwnerId: row.owner.id,
    poolId: row.pool.id,
    securityScope: "token",
    accessGrantId: "grant",
    policy,
    surface: "openai-chat",
    target: row.target(0),
    now: new Date("2030-01-01T00:00:00Z"),
  });
  it("KV prefix evidence requires a live-tip continuation and carries the matched record facts", async () => {
    const f = await fixture();
    const now = new Date("2030-01-01T12:00:00Z");
    const args = {
      ownerId: f.tenant.id,
      resourceOwnerId: f.owner.id,
      poolId: f.pool.id,
      securityScope: "kv-test",
      policy: {
        enabled: true,
        ttlSeconds: 600,
        maxRecords: 100,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      surface: "openai-chat",
      target: f.target(0),
      now,
    };
    const base = {
      model: "alias",
      messages: [
        { role: "system", content: "instructions" },
        { role: "user", content: "start" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
    };
    const stored = await service.rememberAffinity({
      ...args,
      payload: base,
      estimatedTokens: 12_000,
      engineCacheConfirmed: true,
    });
    const continued = {
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: "reply" },
        { role: "user", content: "third" },
      ],
    };
    const rank = (payload: Record<string, unknown>) =>
      service.rankAffinityTargets({
        ...args,
        payload,
        targets: [args.target],
        scoreSingleTarget: true,
        collectPrefixEvidence: true,
        now: new Date(now.getTime() + 1000),
      });
    const result = await rank(continued);
    expect(result.prefixEvidence).toEqual({
      [args.target.executionTargetId]: {
        tokens: 12_000,
        lastUsedAt: now.getTime(),
        confirmed: true,
      },
    });
    const material = service.affinityPrefixDigests({
      ...args,
      payload: continued,
      runtimeIdentity: args.target.targetIdentity,
    });
    const scope = {
      userId: f.owner.id,
      tenantUserId: f.tenant.id,
      poolId: f.pool.id,
      executionTargetId: args.target.executionTargetId,
    };
    expect(await service.resolveAffinitySession(producer, scope, material, now)).toBe(
      stored!.sessionId,
    );
    expect(
      (
        await rank({
          ...base,
          messages: [...base.messages.slice(0, -1), { role: "user", content: "edited second" }],
        })
      ).prefixEvidence,
    ).toEqual({});
    expect((await rank({ ...base, messages: base.messages.slice(0, 2) })).prefixEvidence).toEqual(
      {},
    );
    await service.rememberAffinity({
      ...args,
      payload: base,
      estimatedTokens: 12_000,
      engineCacheConfirmed: false,
    });
    expect((await rank(continued)).prefixEvidence?.[args.target.executionTargetId]?.confirmed).toBe(
      false,
    );
  });

  it.each([
    { name: "live tip", expected: true },
    { name: "ancestor edit", expected: false, edit: true },
    { name: "truncation", expected: false, truncate: true },
    { name: "hint stamped by another session", expected: false, otherStamp: true },
    {
      name: "hint deeper than live tip without a matching tip hint",
      expected: false,
      deeperHint: true,
    },
    { name: "unknown size", expected: false, unknown: true },
    { name: "expired node", expected: false, expiredNode: true },
    { name: "expired hint", expected: false, expiredHint: true },
    { name: "different digest version", expected: false, oldVersion: true },
    { name: "wrong root", expected: false, wrongRoot: true },
    ...(["body", "header"] as const).flatMap((carrier) => [
      { name: `client ${carrier} full prefix`, carrier, expected: true },
      { name: `client ${carrier} id only`, carrier, expected: false, noTip: true },
      { name: `client ${carrier} other tip owner`, carrier, expected: false, otherOwner: true },
      { name: `client ${carrier} edit`, carrier, expected: false, edit: true },
      { name: `client ${carrier} wrong root`, carrier, expected: false, wrongRoot: true },
      { name: `client ${carrier} expired node`, carrier, expected: false, expiredNode: true },
      {
        name: `client ${carrier} starter is not a continuation`,
        carrier,
        expected: false,
        starter: true,
      },
    ]),
  ])("C1a evidence identity: $name", async (row) => {
    if (!db) throw new Error("database unavailable");
    const args = argsFor(await fixture());
    const carrier = "carrier" in row ? row.carrier : undefined;
    const headers =
      carrier === "header" ? new Headers({ "x-session-id": "evidence-client" }) : undefined;
    const body = carrier === "body" ? { conversation_id: "evidence-client" } : {};
    const messages =
      "starter" in row ? [baseHistory[0]!] : [...baseHistory, a("second reply"), u("third")];
    const base = { ...body, messages };
    const stored = await service.rememberAffinity({
      ...args,
      headers,
      payload: base,
      estimatedTokens: 12_000,
      engineCacheConfirmed: true,
    });
    expect(stored).not.toBeNull();
    const scope = {
      userId: args.resourceOwnerId,
      tenantUserId: args.ownerId,
      poolId: args.poolId,
      executionTargetId: args.target.executionTargetId,
    };
    if ("noTip" in row) await db.cacheAffinityNode.deleteMany({ where: scope });
    if ("otherOwner" in row) {
      // Node identity is immutable: seed a separate owner instead of changing it.
      const nodes = await db.cacheAffinityNode.findMany({ where: scope });
      await db.cacheAffinityNode.deleteMany({ where: scope });
      await db.cacheAffinityNode.createMany({
        data: nodes.map((node) => ({
          ...node,
          id: crypto.randomUUID(),
          sessionId: "other-tip-owner",
        })),
      });
    }
    if ("otherStamp" in row)
      await db.cacheAffinityRecord.updateMany({
        where: scope,
        data: { sessionId: "other-hint-owner" },
      });
    if ("unknown" in row)
      await db.cacheAffinityRecord.updateMany({ where: scope, data: { estimatedTokens: null } });
    if ("expiredNode" in row)
      await db.cacheAffinityNode.updateMany({ where: scope, data: { expiresAt: args.now } });
    if ("expiredHint" in row)
      await db.cacheAffinityRecord.updateMany({ where: scope, data: { expiresAt: args.now } });
    if ("oldVersion" in row) {
      const records = await db.cacheAffinityRecord.findMany({ where: scope });
      await db.cacheAffinityRecord.deleteMany({ where: scope });
      await db.cacheAffinityRecord.createMany({
        data: records.map((record) => ({ ...record, digestVersion: 6 })),
      });
    }
    if ("deeperHint" in row) {
      // Keep the real hint at depth 5 while moving the live tip to depth 3:
      // The routing hint cannot substitute for a missing current-tip hint.
      await db.cacheAffinityRecord.deleteMany({ where: { ...scope, prefixDepth: { lte: 3 } } });
      await db.cacheAffinityNode.deleteMany({ where: { ...scope, depth: { gt: 3 } } });
      await db.cacheAffinityNode.updateMany({
        where: { ...scope, depth: 3 },
        data: { isTip: true },
      });
    }
    const request = {
      ...base,
      ...("wrongRoot" in row ? { temperature: 0.8, instructions: "different root" } : {}),
      messages:
        "starter" in row
          ? messages
          : "edit" in row
            ? [...messages.slice(0, -1), u("edited third")]
            : "truncate" in row
              ? messages.slice(0, 3)
              : [...messages, a("third reply"), u("fourth")],
    };
    const material = service.affinityPrefixDigests({
      ...args,
      headers,
      payload: request,
      runtimeIdentity: args.target.targetIdentity,
    });
    const ranked = await service.rankAffinityTargets({
      ...args,
      headers,
      payload: request,
      targets: [args.target],
      scoreSingleTarget: true,
      collectPrefixEvidence: true,
    });
    expect(ranked.prefixEvidence).toEqual(
      row.expected
        ? {
            [args.target.executionTargetId]: {
              tokens: 12_000,
              lastUsedAt: args.now.getTime(),
              confirmed: true,
            },
          }
        : {},
    );
    if (carrier) {
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(stored!.sessionId);
      // Wrapper semantics remain unchanged, with zero query round trips.
      // Spy on an adapter, not the shared proxy: restoring a captured proxy
      // wrapper onto the client would bind later transaction queries to it.
      const identityDb = {
        $queryRaw: producer.$queryRaw,
        cacheAffinityNode: producer.cacheAffinityNode,
      };
      const query = vi.spyOn(identityDb, "$queryRaw");
      try {
        expect(await service.resolveAffinitySession(identityDb, scope, material, args.now)).toBe(
          stored!.sessionId,
        );
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    }
  });

  it.each(["truncate", "hit refresh"] as const)(
    "C1a real fenced %s between the hint read and evidence statement",
    async (kind) => {
      if (!db) throw new Error("database unavailable");
      const args = argsFor(await fixture());
      const messages = [...baseHistory, a("second reply"), u("third")];
      const stored = await service.rememberAffinity({
        ...args,
        payload: { messages },
        estimatedTokens: 100_000,
        engineCacheConfirmed: true,
      });
      const request = { messages: [...messages, a("third reply"), u("fourth")] };
      const findMany = producer.cacheAffinityRecord.findMany.bind(producer.cacheAffinityRecord);
      let interleaved = false;
      const read = async (input?: Prisma.CacheAffinityRecordFindManyArgs) => {
        const records = await findMany(input);
        // These are real PostgreSQL rows. The writer below commits through its
        // real owner/pool fence after this snapshot and before the real evidence statement.
        expect(
          records.some(
            (record) =>
              record.prefixDigest === stored!.tipDigest && record.estimatedTokens === 100_000,
          ),
        ).toBe(true);
        const updated = await service.rememberAffinity({
          ...args,
          payload: { messages: kind === "truncate" ? messages.slice(0, 3) : messages },
          estimatedTokens: kind === "truncate" ? 10_000 : 100_000,
          engineCacheConfirmed: true,
        });
        expect(updated!.sessionId).toBe(stored!.sessionId);
        interleaved = true;
        return records;
      };
      // Wrap only ranking's read dependency; never mutate the shared Prisma
      // proxy or the writer's transaction delegates.
      const records = new Proxy(producer.cacheAffinityRecord, {
        get(delegate, property) {
          return property === "findMany" ? read : Reflect.get(delegate, property);
        },
      });
      const rankDb = new Proxy(producer, {
        get(client, property) {
          return property === "cacheAffinityRecord" ? records : Reflect.get(client, property);
        },
      });
      const ranked = await service.rankAffinityTargets({
        ...args,
        db: rankDb,
        payload: request,
        targets: [args.target],
        scoreSingleTarget: true,
        collectPrefixEvidence: true,
      });
      expect(interleaved).toBe(true);
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(stored!.sessionId);
      expect(ranked.prefixEvidence).toEqual({
        [args.target.executionTargetId]: {
          tokens: kind === "truncate" ? 10_000 : 100_000,
          lastUsedAt: args.now.getTime(),
          confirmed: true,
        },
      });
      const feedback = await import("./kv-eviction-feedback.js");
      expect(
        feedback.qualifiesAsEvictionEvidence({
          policy: {
            enabled: true,
            windowSeconds: 300,
            minTokens: 8192,
            share: "FIRST_COME",
            fixedPercent: null,
          },
          engineKind: "VLLM",
          kvBudgetTokens: 200_000,
          ok: true,
          usage: { promptTokens: 12_000, cacheReadTokens: kind === "truncate" ? 1000 : 10_000 },
          evidence: ranked.prefixEvidence?.[args.target.executionTargetId],
          now: args.now,
        }),
      ).toBe(false);
      const liveTip = await db.cacheAffinityNode.findFirstOrThrow({
        where: { sessionId: stored!.sessionId, isTip: true },
      });
      expect(liveTip.depth).toBe(kind === "truncate" ? 3 : 5);
      const material = service.affinityPrefixDigests({
        ...args,
        payload: request,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(
        await service.resolveAffinitySession(producer, scopeFor(args), material, args.now),
      ).toBe(stored!.sessionId);
      const hint = await db.cacheAffinityRecord.findFirstOrThrow({
        where: { ...scopeFor(args), prefixDigest: liveTip.nodeDigest },
      });
      expect(hint.estimatedTokens).toBe(kind === "truncate" ? 10_000 : 100_000);
      // A subsequent real advance is still attributable to its new exact tip.
      const advanced = await service.rememberAffinity({
        ...args,
        payload: request,
        estimatedTokens: 15_000,
        engineCacheConfirmed: true,
      });
      expect(advanced!.sessionId).toBe(stored!.sessionId);
      const continued = await service.rankAffinityTargets({
        ...args,
        payload: { messages: [...request.messages, a("fourth reply"), u("fifth")] },
        targets: [args.target],
        scoreSingleTarget: true,
        collectPrefixEvidence: true,
      });
      expect(continued.prefixEvidence?.[args.target.executionTargetId]).toEqual({
        tokens: 15_000,
        lastUsedAt: args.now.getTime(),
        confirmed: true,
      });
    },
  );

  it.each(
    (["implicit", "body", "header"] as const).flatMap((carrier) =>
      (["ancestor truncate", "hit refresh", "miss refresh", "advance"] as const).map((kind) => ({
        carrier,
        kind,
      })),
    ),
  )("C2a snapshot interleaving: $carrier $kind", async ({ carrier, kind }) => {
    const args = argsFor(await fixture());
    const headers = carrier === "header" ? new Headers({ "x-session-id": "sibling" }) : undefined;
    const body = carrier === "body" ? { conversation_id: "sibling" } : {};
    const messages = [...baseHistory, a("second reply"), u("third")];
    const stored = await service.rememberAffinity({
      ...args,
      headers,
      payload: { ...body, messages },
      estimatedTokens: 100_000,
      engineCacheConfirmed: true,
    });
    const request = {
      ...body,
      messages:
        kind === "ancestor truncate"
          ? [...messages.slice(0, 3), a("edited second reply"), u("edited third")]
          : [...messages, a("third reply"), u("fourth")],
    };
    const findMany = producer.cacheAffinityRecord.findMany.bind(producer.cacheAffinityRecord);
    let interleaved = false;
    const records = new Proxy(producer.cacheAffinityRecord, {
      get(delegate, property) {
        if (property !== "findMany") return Reflect.get(delegate, property);
        return async (input?: Prisma.CacheAffinityRecordFindManyArgs) => {
          const rows = await findMany(input);
          expect(
            rows.some(
              (row) =>
                row.prefixDepth === (kind === "ancestor truncate" ? 3 : 5) &&
                row.estimatedTokens === 100_000,
            ),
          ).toBe(true);
          const updated = await service.rememberAffinity({
            ...args,
            headers,
            payload: {
              ...body,
              messages:
                kind === "ancestor truncate"
                  ? messages.slice(0, 3)
                  : kind === "advance"
                    ? request.messages
                    : messages,
            },
            estimatedTokens: kind === "ancestor truncate" ? 10_000 : 25_000,
            engineCacheConfirmed: kind !== "miss refresh",
            now: new Date(args.now.getTime() + 1),
          });
          expect(updated!.sessionId).toBe(stored!.sessionId);
          interleaved = true;
          return rows;
        };
      },
    });
    const rankDb = new Proxy(producer, {
      get(client, property) {
        return property === "cacheAffinityRecord" ? records : Reflect.get(client, property);
      },
    });
    const ranked = await service.rankAffinityTargets({
      ...args,
      headers,
      payload: request,
      targets: [args.target],
      scoreSingleTarget: true,
      collectPrefixEvidence: true,
      db: rankDb,
    });
    expect(interleaved).toBe(true);
    expect(ranked.prefixEvidence?.[args.target.executionTargetId]).toEqual({
      tokens: kind === "ancestor truncate" ? 10_000 : 25_000,
      lastUsedAt: args.now.getTime() + 1,
      confirmed: kind !== "miss refresh",
    });
  });

  it.each(["body", "header"] as const)(
    "C2a tied identical client tips: %s proves its own hint",
    async (carrier) => {
      if (!db) throw new Error("database unavailable");
      const args = argsFor(await fixture());
      const payloadFor = (client: string) => ({
        messages: baseHistory,
        ...(carrier === "body" ? { conversation_id: client } : {}),
      });
      const headersFor = (client: string) =>
        carrier === "header" ? new Headers({ "x-session-id": client }) : undefined;
      const stored = [];
      for (const client of ["a", "b"])
        stored.push(
          await service.rememberAffinity({
            ...args,
            headers: headersFor(client),
            payload: payloadFor(client),
            estimatedTokens: client === "a" ? 11_000 : 12_000,
            engineCacheConfirmed: true,
          }),
        );
      expect(stored[0]!.tipDigest).toBe(stored[1]!.tipDigest);
      expect(stored[0]!.sessionId).not.toBe(stored[1]!.sessionId);
      const tips = await db.cacheAffinityNode.findMany({
        where: { ...scopeFor(args), isTip: true },
        orderBy: { sessionId: "asc" },
      });
      expect(tips).toHaveLength(2);
      expect(tips[0]!.expiresAt).toEqual(tips[1]!.expiresAt);
      // Rank the owner the generic implicit tie-break would reject first; then
      // stamp the other owner's shared hint and prove that owner's own footprint.
      const byId = new Map(stored.map((value, index) => [value!.sessionId, ["a", "b"][index]!]));
      for (const tip of [...tips].reverse()) {
        const client = byId.get(tip.sessionId)!;
        const tokens = client === "a" ? 11_000 : 12_000;
        await service.rememberAffinity({
          ...args,
          headers: headersFor(client),
          payload: payloadFor(client),
          estimatedTokens: tokens,
          engineCacheConfirmed: true,
        });
        const ranked = await service.rankAffinityTargets({
          ...args,
          headers: headersFor(client),
          payload: {
            ...payloadFor(client),
            messages: [...baseHistory, a("reply two"), u("fourth")],
          },
          targets: [args.target],
          scoreSingleTarget: true,
          collectPrefixEvidence: true,
        });
        expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(tip.sessionId);
        expect(ranked.prefixEvidence?.[args.target.executionTargetId]).toEqual({
          tokens,
          lastUsedAt: args.now.getTime(),
          confirmed: true,
        });
        const other = tips.find((row) => row.sessionId !== tip.sessionId)!;
        const otherClient = byId.get(other.sessionId)!;
        const otherRank = await service.rankAffinityTargets({
          ...args,
          headers: headersFor(otherClient),
          payload: {
            ...payloadFor(otherClient),
            messages: [...baseHistory, a("reply two"), u("fourth")],
          },
          targets: [args.target],
          scoreSingleTarget: true,
          collectPrefixEvidence: true,
        });
        expect(otherRank.prefixEvidence).toEqual({}); // A shared hint proves only its latest owner.
      }
    },
  );

  it.each(["body", "header"] as const)(
    "C2a client %s ignores another session's deeper routing hint",
    async (carrier) => {
      const args = argsFor(await fixture());
      const headersFor = (client: string) =>
        carrier === "header" ? new Headers({ "x-session-id": client }) : undefined;
      const payloadFor = (client: string, messages: typeof baseHistory) => ({
        messages,
        ...(carrier === "body" ? { conversation_id: client } : {}),
      });
      const deeper = [...baseHistory, a("second reply"), u("third")];
      const stored = await service.rememberAffinity({
        ...args,
        headers: headersFor("a"),
        payload: payloadFor("a", baseHistory),
        estimatedTokens: 12_000,
        engineCacheConfirmed: true,
      });
      await service.rememberAffinity({
        ...args,
        headers: headersFor("b"),
        payload: payloadFor("b", deeper),
        estimatedTokens: 50_000,
        engineCacheConfirmed: true,
      });
      await service.rememberAffinity({
        ...args,
        headers: headersFor("a"),
        payload: payloadFor("a", baseHistory),
        estimatedTokens: 12_000,
        engineCacheConfirmed: true,
      });
      const ranked = await service.rankAffinityTargets({
        ...args,
        headers: headersFor("a"),
        payload: payloadFor("a", [...deeper, a("third reply"), u("fourth")]),
        targets: [args.target],
        scoreSingleTarget: true,
        collectPrefixEvidence: true,
      });
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(stored!.sessionId);
      expect(ranked.prefixDepths[args.target.executionTargetId]).toBe(5);
      expect(ranked.prefixTokens?.[args.target.executionTargetId]).toBe(50_000);
      expect(ranked.prefixEvidence?.[args.target.executionTargetId]).toEqual({
        tokens: 12_000,
        lastUsedAt: args.now.getTime(),
        confirmed: true,
      });
    },
  );

  it("C2a maximum-tail client rank uses population-independent point lookups", async () => {
    if (!db) throw new Error("database unavailable");
    const { Prisma } = await import("@ws-model-proxy/db");
    const args = { ...argsFor(await fixture()), policy: { ...policy, maxRecords: 100_000 } };
    const messages = Array.from({ length: 64 }, (_, i) =>
      i % 2 ? a(`answer ${i}`) : u(`question ${i}`),
    );
    const payload = { conversation_id: "maximum-tail", messages };
    await service.rememberAffinity({
      ...args,
      payload,
      estimatedTokens: 12_000,
      engineCacheConfirmed: true,
    });
    const request = { ...payload, messages: [...messages, u("next")] };
    const material = service.affinityPrefixDigests({
      ...args,
      payload: request,
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(material.nodes).toHaveLength(64);
    const expiry = new Date(args.now.getTime() + 60_000);
    type Plan = {
      "Node Type": string;
      "Index Name"?: string;
      "Index Cond"?: string;
      "Shared Hit Blocks"?: number;
      "Shared Read Blocks"?: number;
      "Actual Rows"?: number;
      "Actual Loops"?: number;
      Plans?: Plan[];
    };
    const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const work: number[] = [];
    const scanPlans: Plan[][] = [];
    for (const count of [1000, 20_000]) {
      const first = count === 1000 ? 1 : 1001;
      // Competing tips and ancestors across the entire request tail; records
      // span the same scope/digests with other bindings, so even the narrower
      // non-unique record index faces the competitor population.
      await db.$executeRaw`INSERT INTO cache_affinity_node
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", depth, "sessionId", "isTip", "expiresAt")
        SELECT 'work-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId}, ${material.rootDigest},
          (${JSON.stringify(material.nodes)}::jsonb -> ((i % 64)::int) ->> 'digest'), (i % 64)::int + 1, 'work-' || ${args.poolId} || i, i % 2 = 0, ${expiry}
        FROM generate_series(${first}::int, ${count}::int) i ORDER BY md5(i::text)`;
      await db.$executeRaw`INSERT INTO cache_affinity_record
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "prefixDigest", "sessionId", "prefixDepth", "expiresAt", "lastUsedAt")
        SELECT 'work-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId}, ${args.target.targetIdentity}, md5('other-binding-' || i),
          (${JSON.stringify(material.nodes)}::jsonb -> ((i % 64)::int) ->> 'digest'), 'work-' || ${args.poolId} || i, (i % 64)::int + 1, ${expiry}, ${args.now}
        FROM generate_series(${first}::int, ${count}::int) i ORDER BY md5(i::text)`;
      await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_node");
      await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_record");
      // Capture the statement actually issued by ranking, so a replacement
      // with the old population-dependent probe cannot escape this check.
      const queries: Prisma.Sql[] = [];
      const rankDb = new Proxy(producer, {
        get(client, property) {
          return property === "$queryRaw"
            ? async (query: Prisma.Sql) => {
                queries.push(query);
                return producer.$queryRaw(query);
              }
            : Reflect.get(client, property);
        },
      });
      const ranked = await service.rankAffinityTargets({
        ...args,
        payload: request,
        targets: [args.target],
        scoreSingleTarget: true,
        collectPrefixEvidence: true,
        db: rankDb,
      });
      expect(ranked.prefixEvidence?.[args.target.executionTargetId]?.tokens).toBe(12_000);
      expect(queries).toHaveLength(1); // Client identity retains its zero-query shortcut.
      const [explain] = await producer.$queryRaw<{ "QUERY PLAN": { Plan: Plan }[] }[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries[0]!}`,
      );
      const plan = explain!["QUERY PLAN"][0]!.Plan;
      const scans = flatten(plan).filter(
        (node) => node["Node Type"].includes("Scan") && node["Index Name"],
      );
      scanPlans.push(scans);
      const buffers = (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
      work.push(buffers);
      expect(buffers).toBeLessThan(1000);
      process.stdout.write(
        `${JSON.stringify({ evidenceWork: { count, buffers, indexes: scans.map((scan) => scan["Index Name"]) } })}\n`,
      );
    }
    expect(work[1]! / Math.max(1, work[0]!)).toBeLessThanOrEqual(2);
    for (const scans of scanPlans) {
      expect(scans.length).toBeGreaterThanOrEqual(2);
      for (const scan of scans) {
        expect(scan["Index Cond"]).not.toMatch(/ROW\(|[<>]/);
        if (scan["Index Name"]?.startsWith("cache_affinity_node"))
          expect(scan["Index Cond"]).toContain("sessionId");
        else
          for (const key of [
            "tenantUserId",
            "poolId",
            "executionTargetId",
            "targetIdentity",
            "bindingDigest",
            "prefixDigest",
          ])
            expect(scan["Index Cond"]).toContain(key);
        expect((scan["Actual Rows"] ?? 0) * (scan["Actual Loops"] ?? 0)).toBeLessThanOrEqual(64);
      }
      expect(scans.some((scan) => scan["Index Name"] === "cache_affinity_node_owner_unique")).toBe(
        true,
      );
    }
  }, 60_000);

  function scopeFor(args: ReturnType<typeof argsFor>) {
    return {
      userId: args.resourceOwnerId,
      tenantUserId: args.ownerId,
      poolId: args.poolId,
      executionTargetId: args.target.executionTargetId,
    };
  }

  it.each(numericOverflowRows)(
    "R4 PG numeric overflow $surface $shape uses forwarded null identity",
    async ({ surface, shape }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const absent = await service.rememberAffinity({
        ...args,
        payload: numericOverflowPayload(surface, shape, undefined),
      });
      const nilPayload = numericOverflowPayload(surface, shape, "null");
      const nil = await service.rememberAffinity({ ...args, payload: nilPayload });
      const finite = await service.rememberAffinity({
        ...args,
        payload: numericOverflowPayload(surface, shape, "1e300"),
      });
      expect(nil!.rootDigest).not.toBe(absent!.rootDigest);
      expect(nil!.sessionId).not.toBe(absent!.sessionId);
      expect(finite!.sessionId).not.toBe(nil!.sessionId);
      for (const value of ["1e400", "-1e400"]) {
        const payload = numericOverflowPayload(surface, shape, value);
        const material = service.affinityPrefixDigests({
          ...args,
          payload,
          runtimeIdentity: args.target.targetIdentity,
        });
        expect(material.rootDigest).toBe(nil!.rootDigest);
        expect(
          await service.resolveAffinitySession(
            producer,
            {
              userId: args.resourceOwnerId,
              tenantUserId: args.ownerId,
              poolId: args.poolId,
              executionTargetId: args.target.executionTargetId,
            },
            material,
            args.now,
          ),
        ).toBe(nil!.sessionId);
        const bound = await service.rememberAffinity({ ...args, payload });
        expect(bound!.sessionId).toBe(nil!.sessionId);
        expect(bound!.rootDigest).toBe(nil!.rootDigest);
        expect(
          (await service.rememberAffinity({
            ...args,
            payload: JSON.parse(JSON.stringify(payload)),
          }))!.sessionId,
        ).toBe(nil!.sessionId);
      }
      if (surface === "openai-responses") {
        for (const value of ["1e400", "-1e400"]) {
          const payload = {
            ...numericOverflowPayload(surface, shape, value),
            previous_response_id: "parent",
            input: "delta",
          };
          const material = service.affinityPrefixDigests({
            ...args,
            payload,
            sessionBinding: nil!,
            runtimeIdentity: args.target.targetIdentity,
          });
          expect(material.boundSessionId).toBe(nil!.sessionId);
          expect(material.rootDigest).toBe(nil!.rootDigest);
          const bound = await service.rememberAffinity({ ...args, payload, sessionBinding: nil! });
          expect(bound!.sessionId).toBe(nil!.sessionId);
          expect(bound!.rootDigest).toBe(nil!.rootDigest);
        }
      }
    },
  );

  it.each(["parameter", "tools", "instructions", "messages"] as const)(
    "R2 wire __proto__ changes %s roots or nodes and committed sessions PG",
    async (location) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const request = (value: string) =>
        JSON.parse(
          canonicalPayloadWire(
            location,
            `{"nested":[{"__proto__":{"const":${JSON.stringify(value)}}}]}`,
          ),
        );
      const first = await service.rememberAffinity({ ...args, payload: request("one") });
      const second = await service.rememberAffinity({ ...args, payload: request("two") });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.sessionId).not.toBe(first!.sessionId);
      if (location !== "messages") expect(second!.rootDigest).not.toBe(first!.rootDigest);
      expect(second!.tipDigest).not.toBe(first!.tipDigest);
    },
  );

  it.each(depthRows)(
    "R2 PG $location $shape depth $depth has no partial identity or lineage",
    async ({ location, shape, depth }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const payload = JSON.parse(depthPayloadWire(location, depth, shape));
      const material = service.affinityPrefixDigests({
        ...args,
        payload,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(material.identifiable).toBe(depth === MAX_CANONICAL_DEPTH);
      if (depth === MAX_CANONICAL_DEPTH) {
        expect(await service.rememberAffinity({ ...args, payload })).not.toBeNull();
        expect(
          await db.cacheAffinityNode.count({ where: { poolId: args.poolId } }),
        ).toBeGreaterThan(0);
        return;
      }
      const parent = await service.rememberAffinity({
        ...args,
        payload: { input: "parent", conversation: "client" },
      });
      const beforeNodes = await db.cacheAffinityNode.findMany({
        where: { poolId: args.poolId },
        orderBy: { id: "asc" },
      });
      const beforeRecords = await db.cacheAffinityRecord.findMany({
        where: { poolId: args.poolId },
        orderBy: { id: "asc" },
      });
      const bound = { ...payload, previous_response_id: "parent", conversation: "client" };
      const boundMaterial = service.affinityPrefixDigests({
        ...args,
        payload: bound,
        sessionBinding: parent!,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(boundMaterial).toMatchObject({
        identifiable: false,
        nodes: [],
        routingNodes: [],
        instructionDigests: [],
        digests: [],
      });
      expect(boundMaterial.clientSessionId).toBeUndefined();
      expect(boundMaterial.boundSessionId).toBeUndefined();
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          await service.rememberAffinity({ ...args, payload: bound, sessionBinding: parent! }),
        ).toBeNull();
      expect(
        await db.cacheAffinityNode.findMany({
          where: { poolId: args.poolId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(beforeNodes);
      expect(
        await db.cacheAffinityRecord.findMany({
          where: { poolId: args.poolId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(beforeRecords);
      // Neither a client id nor a server binding survives refusal. Ordinary starters
      // after these refused writes still allocate fresh, independent sessions.
      const starters = [];
      for (let attempt = 0; attempt < 2; attempt++)
        starters.push(await service.rememberAffinity({ ...args, payload: { input: "fresh" } }));
      expect(starters[0]!.sessionId).not.toBe(starters[1]!.sessionId);
      expect(starters.every((starter) => starter!.sessionId !== parent!.sessionId)).toBe(true);
    },
  );

  it("R2 client-id root changes prune all old hints and bound turns retain only their own root PG", async () => {
    if (!db) return;
    const args = { ...argsFor(await fixture()), surface: "openai-responses" };
    const initial = await service.rememberAffinity({
      ...args,
      payload: { conversation: "client", instructions: "root A", input: baseHistory },
    });
    const oldNodes = await db.cacheAffinityNode.findMany({
      where: { sessionId: initial!.sessionId },
    });
    const changed = await service.rememberAffinity({
      ...args,
      payload: { conversation: "client", instructions: "root B", input: baseHistory },
    });
    expect(changed!.sessionId).toBe(initial!.sessionId);
    expect(changed!.rootDigest).not.toBe(initial!.rootDigest);
    expect(
      await db.cacheAffinityNode.count({
        where: { sessionId: initial!.sessionId, rootDigest: initial!.rootDigest },
      }),
    ).toBe(0);
    expect(
      await db.cacheAffinityRecord.count({
        where: {
          sessionId: initial!.sessionId,
          prefixDigest: { in: oldNodes.map((node) => node.nodeDigest) },
        },
      }),
    ).toBe(0);
    // A durable older response may still be followed after a stateless root change.
    // The explicit client id is authoritative; root B is not ancestry of root A.
    const follow = await service.rememberAffinity({
      ...args,
      sessionBinding: initial!,
      payload: {
        previous_response_id: "original-response",
        conversation: "client",
        input: [u("delta")],
      },
    });
    expect(follow!.sessionId).toBe(initial!.sessionId);
    expect(follow!.rootDigest).toBe(initial!.rootDigest);
    expect(follow!.tipDepth).toBe(initial!.tipDepth + 1);
    const nodes = await db.cacheAffinityNode.findMany({ where: { sessionId: follow!.sessionId } });
    expect(nodes).toHaveLength(1);
    expect(nodes.every((node) => node.rootDigest === follow!.rootDigest)).toBe(true);
    expect(nodes[0]).toMatchObject({ nodeDigest: follow!.tipDigest, isTip: true });
    const next = await service.rememberAffinity({
      ...args,
      sessionBinding: follow!,
      payload: {
        previous_response_id: "next-response",
        conversation: "client",
        input: [u("next delta")],
      },
    });
    const retained = await db.cacheAffinityNode.findMany({ where: { sessionId: next!.sessionId } });
    expect(retained).toHaveLength(2);
    expect(retained.every((node) => node.rootDigest === next!.rootDigest)).toBe(true);
    expect(retained.some((node) => node.nodeDigest === follow!.tipDigest && !node.isTip)).toBe(
      true,
    );
  });

  it.each(["empty", "replayed"] as const)(
    "R5 bound %s delta re-stamps the existing tip through ON CONFLICT PG",
    async (kind) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const parent = await service.rememberAffinity({
        ...args,
        payload: { input: [u("create"), a("reply")] },
      });
      expect(parent).not.toBeNull();
      const payload = {
        input: kind === "empty" ? [] : [u("delta")],
        previous_response_id: "parent",
      };
      const committed = await service.rememberAffinity({
        ...args,
        payload,
        sessionBinding: parent!,
      });
      expect(committed).not.toBeNull();
      const where = { poolId: args.poolId, sessionId: committed!.sessionId };
      const committedTips = await db.cacheAffinityNode.findMany({
        where: { ...where, isTip: true },
      });
      expect(committedTips.map((node) => node.nodeDigest)).toEqual([committed!.tipDigest]);
      const originalTip = committedTips[0]!;
      for (let replay = 1; replay <= 3; replay++) {
        const now = new Date(args.now.getTime() + replay * 1000);
        const refreshed = await service.rememberAffinity({
          ...args,
          now,
          payload,
          sessionBinding: parent!,
        });
        expect(refreshed).toMatchObject({
          sessionId: committed!.sessionId,
          tipDigest: committed!.tipDigest,
          tipDepth: committed!.tipDepth,
        });
        const nodes = await db.cacheAffinityNode.findMany({ where });
        expect(nodes).toHaveLength(kind === "empty" ? 2 : 3);
        expect(nodes.filter((node) => node.isTip)).toEqual([
          expect.objectContaining({
            id: originalTip.id,
            nodeDigest: committed!.tipDigest,
            depth: committed!.tipDepth,
          }),
        ]);
        expect(
          nodes.every(
            (node) => node.expiresAt.getTime() === now.getTime() + policy.ttlSeconds * 1000,
          ),
        ).toBe(true);
      }
    },
  );

  it.each(
    (["existing", "parent"] as const).flatMap((read) =>
      (["chain", "ancestor"] as const).map((expired) => ({ read, expired })),
    ),
  )(
    "R5 expired $expired rows on $read node read cannot prove or resurrect ancestry PG",
    async ({ read, expired }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const parent = await service.rememberAffinity({
        ...args,
        payload: { input: [u("create"), a("reply")], conversation: "parent-client" },
      });
      expect(parent).not.toBeNull();
      const parentWhere = { poolId: args.poolId, sessionId: parent!.sessionId };
      const oldNodes = await db.cacheAffinityNode.findMany({
        where: parentWhere,
        orderBy: { depth: "asc" },
      });
      expect(oldNodes).toHaveLength(2);
      const expiredDigests =
        expired === "chain" ? oldNodes.map((node) => node.nodeDigest) : [oldNodes[0]!.nodeDigest];
      await db.cacheAffinityNode.updateMany({
        where: { ...parentWhere, nodeDigest: { in: expiredDigests } },
        data: { expiresAt: new Date(args.now.getTime() - 1) },
      });
      // The writer sweeps only 200 rows. An older backlog ensures the tested
      // expired rows survive that sweep and reach the two ancestry reads.
      await db.$executeRaw`INSERT INTO cache_affinity_node
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", depth, "sessionId", "isTip", "expiresAt")
        SELECT 'expiry-gap-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId},
          md5('backlog-root'), md5('backlog-' || i), 1, 'backlog-' || i, true, ${new Date(args.now.getTime() - 2000)}
        FROM generate_series(1, 200) i`;
      const payload = {
        input: [u("delta")],
        previous_response_id: "parent",
        conversation: read === "existing" ? "parent-client" : "fresh-client",
      };
      const material = service.affinityPrefixDigests({
        ...args,
        payload,
        sessionBinding: parent!,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(material.parentTipDigest).toBe(parent!.tipDigest);
      const next = await service.rememberAffinity({ ...args, payload, sessionBinding: parent! });
      expect(next).not.toBeNull();
      expect(next!.sessionId === parent!.sessionId).toBe(read === "existing");
      const nodes = await db.cacheAffinityNode.findMany({
        where: { poolId: args.poolId, sessionId: next!.sessionId },
        orderBy: { depth: "asc" },
      });
      const expectedDigests =
        expired === "chain" ? material.digests : [parent!.tipDigest, ...material.digests];
      expect(nodes.map((node) => node.nodeDigest)).toEqual(expectedDigests);
      expect(nodes.some((node) => expiredDigests.includes(node.nodeDigest))).toBe(false);
      expect(nodes.filter((node) => node.isTip).map((node) => node.nodeDigest)).toEqual([
        next!.tipDigest,
      ]);
      expect(nodes.every((node) => node.expiresAt > args.now)).toBe(true);
      if (read === "parent") {
        // The source rows remain expired; the durable binding does not renew them.
        const remaining = await db.cacheAffinityNode.findMany({ where: parentWhere });
        expect(remaining).toHaveLength(2);
        expect(
          remaining
            .filter((node) => expiredDigests.includes(node.nodeDigest))
            .every((node) => node.expiresAt <= args.now),
        ).toBe(true);
      }
    },
  );

  it.each(
    [false, true].flatMap((olderSameSession) =>
      [false, true].map((repeatRoot) => ({ olderSameSession, repeatRoot })),
    ),
  )(
    "R3 same-root bound rebase discards unrelated ancestors olderSameSession=$olderSameSession repeatRoot=$repeatRoot PG",
    async ({ olderSameSession, repeatRoot }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const historyA = [u("A start"), a("A reply"), u("A next")];
      const historyB = [u("B start"), a("B reply"), u("B next")];
      const root = {
        instructions: "shared rules",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        text: { format: { type: "text" } },
      };
      const initialA = await service.rememberAffinity({
        ...args,
        payload: { ...root, conversation: "client-A", input: historyA },
      });
      const initialB = await service.rememberAffinity({
        ...args,
        payload: {
          ...root,
          conversation: olderSameSession ? "client-A" : "client-B",
          input: historyB,
        },
      });
      expect(initialB!.rootDigest).toBe(initialA!.rootDigest);
      expect(initialB!.sessionId === initialA!.sessionId).toBe(olderSameSession);
      const oldBNodes = await db.cacheAffinityNode.findMany({
        where: { sessionId: initialB!.sessionId },
      });
      const routingOnly = service.affinityPrefixDigests({
        ...args,
        runtimeIdentity: args.target.targetIdentity,
        payload: {
          ...root,
          conversation: olderSameSession ? "client-A" : "client-B",
          input: [
            ...historyB,
            ...Array.from({ length: 80 }, (_, i) => u(`B tail ${i}`)),
            u("x".repeat(2 * 1024 * 1024)),
          ],
        },
      });
      expect(routingOnly.nodes).toEqual([]);
      expect(routingOnly.routingNodes).toHaveLength(64);
      expect(
        await service.rememberAffinity({
          ...args,
          payload: {
            ...root,
            conversation: olderSameSession ? "client-A" : "client-B",
            input: [
              ...historyB,
              ...Array.from({ length: 80 }, (_, i) => u(`B tail ${i}`)),
              u("x".repeat(2 * 1024 * 1024)),
            ],
          },
        }),
      ).toBeNull();
      const follow = await service.rememberAffinity({
        ...args,
        sessionBinding: initialA!,
        payload: {
          ...(repeatRoot ? root : {}),
          previous_response_id: "response-A",
          conversation: olderSameSession ? "client-A" : "client-B",
          input: [a("A continuation")],
        },
      });
      expect(follow!.sessionId).toBe(initialB!.sessionId);
      expect(follow!.rootDigest).toBe(initialA!.rootDigest);
      expect(follow!.tipDepth).toBe(4);
      const nodes = await db.cacheAffinityNode.findMany({
        where: { sessionId: follow!.sessionId },
      });
      expect(nodes).toHaveLength(olderSameSession ? 1 : 4);
      expect(
        nodes.filter((node) => oldBNodes.some((old) => old.nodeDigest === node.nodeDigest)),
      ).toEqual([]);
      expect(
        await db.cacheAffinityRecord.count({
          where: {
            sessionId: follow!.sessionId,
            prefixDigest: { in: oldBNodes.map((node) => node.nodeDigest) },
          },
        }),
      ).toBe(0);
      expect(
        await db.cacheAffinityRecord.count({
          where: {
            sessionId: follow!.sessionId,
            prefixDigest: { in: routingOnly.digests },
          },
        }),
      ).toBe(0);
      const oldRank = await service.rankAffinityTargets({
        ...args,
        payload: { ...root, input: [...historyB, a("B continuation")] },
        targets: [args.target],
        scoreSingleTarget: true,
      });
      expect(oldRank.matchedSessionIds?.[args.target.executionTargetId]).toBeUndefined();
      if (!olderSameSession) {
        const currentRank = await service.rankAffinityTargets({
          ...args,
          payload: { ...root, input: [...historyA, a("A continuation")] },
          targets: [args.target],
          scoreSingleTarget: true,
        });
        expect(currentRank.matchedSessionIds?.[args.target.executionTargetId]).toBe(
          initialB!.sessionId,
        );
        const instructions = service.affinityPrefixDigests({
          ...args,
          payload: { ...root, input: historyA },
          runtimeIdentity: args.target.targetIdentity,
        }).instructionDigests;
        expect(
          await db.cacheAffinityRecord.count({
            where: { sessionId: follow!.sessionId, prefixDigest: { in: instructions } },
          }),
        ).toBe(instructions.length);
      }
      const oldWrite = await service.rememberAffinity({
        ...args,
        payload: { ...root, input: [...historyB, a("B continuation")] },
      });
      expect(oldWrite!.sessionId).not.toBe(initialB!.sessionId);
    },
  );

  const permutations = <T>(items: T[]): T[][] =>
    items.length === 0
      ? [[]]
      : items.flatMap((item, i) =>
          permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]),
        );
  // Four arrivals have 24 permutations; six respect X1<X2 and Y1<Y2.
  const orders = permutations(["X1", "Y1", "X2", "Y2"]).filter(
    (order) =>
      order.indexOf("X1") < order.indexOf("X2") && order.indexOf("Y1") < order.indexOf("Y2"),
  );
  it.each(
    instructionPlacementRows.flatMap((row) => [
      ...orders.map((order) => ({ ...row, order, schedule: order.join(",") })),
      { ...row, order: [] as string[], schedule: "concurrent" },
    ]),
  )(
    "R7 PG placement $surface $role $schedule keeps two independent sessions",
    async ({ surface, role, order, schedule }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const instruction = { role, content: "S" };
      const history = (label: string) => {
        const starter = label.startsWith("X") ? [instruction, u("U")] : [u("U"), instruction];
        return label.endsWith("1") ? starter : [...starter, a("A"), u("V")];
      };
      const results = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof service.rememberAffinity>>>
      >();
      const run = async (label: string) => {
        const result = await service.rememberAffinity({
          ...args,
          payload: orderedHistoryPayload(surface, history(label)),
        });
        if (!result) throw new Error("missing committed instruction-placement binding");
        results.set(label, result);
      };
      if (schedule === "concurrent") {
        await Promise.all([run("X1"), run("Y1")]);
        await Promise.all([run("X2"), run("Y2")]);
      } else for (const label of order) await run(label);
      const x1 = results.get("X1")!;
      const y1 = results.get("Y1")!;
      const x2 = results.get("X2")!;
      const y2 = results.get("Y2")!;
      expect(x1.sessionId).not.toBe(y1.sessionId);
      expect(x2.sessionId).toBe(x1.sessionId);
      expect(y2.sessionId).toBe(y1.sessionId);
      expect(x2.rootDigest).toBe(x1.rootDigest);
      expect(y2.rootDigest).toBe(y1.rootDigest);
      expect(x2.rootDigest).not.toBe(y2.rootDigest);
      expect(x2.tipDigest).not.toBe(y2.tipDigest);
      for (const label of ["X2", "Y2"]) {
        const request = { ...args, payload: orderedHistoryPayload(surface, history(label)) };
        const material = service.affinityPrefixDigests({
          ...request,
          runtimeIdentity: args.target.targetIdentity,
        });
        expect(
          await service.resolveAffinitySession(
            producer,
            {
              userId: args.resourceOwnerId,
              tenantUserId: args.ownerId,
              poolId: args.poolId,
              executionTargetId: args.target.executionTargetId,
            },
            material,
            args.now,
          ),
        ).toBe(results.get(label)!.sessionId);
        const ranked = await service.rankAffinityTargets({
          ...request,
          targets: [args.target],
          scoreSingleTarget: true,
        });
        expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(
          results.get(label)!.sessionId,
        );
      }
      expect(
        await db.cacheAffinityRecord.groupBy({
          by: ["sessionId"],
          where: { poolId: args.poolId },
        }),
      ).toHaveLength(2);
      expect(
        await db.cacheAffinityNode.count({
          where: { poolId: args.poolId, isTip: true },
        }),
      ).toBe(2);
    },
  );

  it.each(instructionPlacementRows)(
    "R7 PG edits $surface $role keep late edits and truncations but split leading changes",
    async ({ surface, role }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const leading = { role, content: "leading" };
      const prefix = [leading, u("U"), a("A")];
      const write = (units: unknown[]) =>
        service.rememberAffinity({
          ...args,
          payload: orderedHistoryPayload(surface, units),
        });
      const original = await write([...prefix, { role, content: "late" }, u("V"), a("reply")]);
      const edited = await write([...prefix, { role, content: "edited late" }, u("V"), a("reply")]);
      expect(edited!.sessionId).toBe(original!.sessionId);
      expect(edited!.rootDigest).toBe(original!.rootDigest);
      expect(edited!.tipDigest).not.toBe(original!.tipDigest);
      const truncated = await write(prefix);
      expect(truncated!.sessionId).toBe(original!.sessionId);
      expect(truncated!.rootDigest).toBe(original!.rootDigest);
      expect(truncated!.tipDepth).toBe(2);
      const changed = await write([{ role, content: "changed leading" }, ...prefix.slice(1)]);
      expect(changed!.rootDigest).not.toBe(original!.rootDigest);
      expect(changed!.sessionId).not.toBe(original!.sessionId);
      const ranked = await service.rankAffinityTargets({
        ...args,
        payload: orderedHistoryPayload(surface, [leading, u("independent starter")]),
        targets: [args.target],
        scoreSingleTarget: true,
      });
      expect(ranked.instructionDepths?.[args.target.executionTargetId]).toBe(1);
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBeUndefined();
    },
  );

  it.each(instructionPlacementRows)(
    "R7 PG authoritative id $surface $role survives instruction relocation",
    async ({ surface, role }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const instruction = { role, content: "S" };
      const first = await service.rememberAffinity({
        ...args,
        payload: {
          ...orderedHistoryPayload(surface, [instruction, u("U")]),
          conversation_id: "client",
        },
      });
      const moved = await service.rememberAffinity({
        ...args,
        payload: {
          ...orderedHistoryPayload(surface, [u("U"), instruction, a("A"), u("V")]),
          conversation_id: "client",
        },
      });
      expect(moved!.sessionId).toBe(first!.sessionId);
      expect(moved!.rootDigest).not.toBe(first!.rootDigest);
      expect(
        await db.cacheAffinityNode.count({
          where: { sessionId: first!.sessionId, isTip: true },
        }),
      ).toBe(1);
    },
  );
  it.each(orders.map((order) => [order.join(","), order] as const))(
    "interleaving %s",
    async (_, order) => {
      if (!db) return;
      const row = await fixture();
      const args = argsFor(row);
      const sessions: Record<string, string> = {};
      for (const label of order) {
        const messages = label.endsWith("1")
          ? [u("shared starter")]
          : [u("shared starter"), a(`reply ${label[0]}`), u(`next ${label[0]}`)];
        const request = { ...args, payload: { messages } };
        const result = await service.rememberAffinity(request);
        sessions[label] = result!.sessionId;
        if (label.endsWith("2")) {
          const rank = await service.rankAffinityTargets({
            ...request,
            targets: [args.target],
            scoreSingleTarget: true,
          });
          expect(rank.matchedSessionIds?.[args.target.executionTargetId]).toBe(result!.sessionId);
        }
      }
      expect(new Set(Object.values(sessions)).size).toBe(2);
      expect(sessions.X2).not.toBe(sessions.Y2);
      const warm = await db.cacheAffinityRecord.groupBy({
        by: ["sessionId"],
        where: { poolId: row.pool.id },
      });
      expect(warm).toHaveLength(2);
    },
  );

  it("concurrent completions reread advanced tips inside the fence", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    const write = (messages: unknown[]) =>
      service.rememberAffinity({ ...args, payload: { messages } });
    const starters = await Promise.all([
      write([u("shared starter")]),
      write([u("shared starter")]),
    ]);
    expect(starters[0]!.sessionId).not.toBe(starters[1]!.sessionId);
    const next = await Promise.all([
      write(baseHistory),
      write([u("shared starter"), a("Y"), u("Y2")]),
    ]);
    expect(new Set(next.map((r) => r!.sessionId))).toEqual(
      new Set(starters.map((r) => r!.sessionId)),
    );
  });

  const documentedCases = orders.flatMap((order) =>
    [false, true].flatMap((withId) =>
      [false, true].flatMap((identicalNext) =>
        [false, true].map((concurrent) => ({
          order,
          label: order.join(","),
          withId,
          identicalNext,
          concurrent,
          kind: "documented limit",
          greeting: false,
          surface: "openai-chat",
        })),
      ),
    ),
  );
  const greetingCases = ["openai-chat", "anthropic-messages", "openai-responses"].flatMap(
    (surface) =>
      orders.flatMap((order) =>
        [false, true].map((concurrent) => ({
          order,
          label: order.join(","),
          withId: false,
          identicalNext: false,
          concurrent,
          kind: "R1 greeting",
          greeting: true,
          surface,
        })),
      ),
  );
  it.each([...documentedCases, ...greetingCases])(
    "interleaving $kind $surface: $label ids=$withId identical next=$identicalNext concurrent=$concurrent",
    async ({ order, withId, identicalNext, concurrent, greeting, surface }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const results: Record<string, string> = {};
      const writes = new Map<
        string,
        Promise<NonNullable<Awaited<ReturnType<typeof service.rememberAffinity>>>>
      >();
      const run = async (label: string) => {
        // Sequential runs await each commit below. Concurrent runs queue all four
        // writes at the real fence in the specified causal arrival order.
        const starter = greeting
          ? [a("welcome"), u(`starter ${label[0]}`)]
          : [u("same first message")];
        const messages = label.endsWith("1")
          ? starter
          : [
              ...starter,
              a(identicalNext ? "same reply" : `reply ${label[0]}`),
              u(identicalNext ? "same next" : `next ${label[0]}`),
            ];
        const request = {
          ...args,
          payload: {
            ...(surface === "openai-responses" ? { input: messages } : { messages }),
            ...(withId ? { conversation_id: label[0] } : {}),
          },
        };
        // Simultaneous ranking is advisory; each completion resolves inside the fence.
        await service.rankAffinityTargets({
          ...request,
          targets: [args.target],
          scoreSingleTarget: true,
        });
        const result = await service.rememberAffinity(request);
        if (!result) throw new Error("missing committed binding");
        results[label] = result.sessionId;
        return result;
      };
      if (concurrent) {
        let release: (() => void) | undefined;
        let ready: ((pid: number) => void) | undefined;
        const acquired = new Promise<number>((resolve) => {
          ready = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const blocker = db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT wsmp_acquire_fences(ARRAY[${`09:cache-affinity:${args.resourceOwnerId}:${args.poolId}`}]::text[], true)`;
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            ready!(backend!.pid);
            await hold;
          },
          { timeout: 10000 },
        );
        const pid = await acquired;
        try {
          for (const [index, label] of order.entries()) {
            const writing = run(label);
            // Attach a rejection handler immediately; the assertion below and
            // Promise.all after release still surface any failure.
            void writing.catch(() => undefined);
            writes.set(label, writing);
            const deadline = performance.now() + 800;
            let queued = false;
            while (performance.now() < deadline) {
              const [locks] = await db.$queryRaw<{ count: bigint }[]>`
                SELECT count(*) AS count FROM pg_locks waiting
                 WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
                   AND EXISTS (SELECT 1 FROM pg_locks held WHERE held.pid = ${pid}
                     AND held.locktype = 'advisory' AND held.granted
                     AND held.classid = waiting.classid AND held.objid = waiting.objid
                     AND held.objsubid = waiting.objsubid)`;
              if (Number(locks!.count) === index + 1) {
                queued = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            expect(queued, `arrival ${label} queued at the fence`).toBe(true);
          }
        } finally {
          release!();
          await blocker;
          await Promise.all(writes.values());
        }
      } else {
        for (const label of order) {
          const writing = run(label);
          writes.set(label, writing);
          await writing;
        }
      }
      expect(results.X1).not.toBe(results.Y1);
      expect(new Set(Object.values(results)).size).toBe(2);
      if (withId || !identicalNext) expect(results.X2).not.toBe(results.Y2);
      else expect(results.X2).toBe(results.Y2); // both take the deepest identical tip, all six orders
      if (withId || greeting) {
        expect(results.X1).toBe(results.X2);
        expect(results.Y1).toBe(results.Y2);
      }
      expect(
        await db.cacheAffinityRecord.groupBy({ by: ["sessionId"], where: { poolId: args.poolId } }),
      ).toHaveLength(2);
    },
  );

  it("client-id security table: tenants, grants, pools, targets, surfaces cannot cross-read or mutate", async () => {
    if (!db) return;
    const row = await fixture();
    const args = argsFor(row);
    const id = `private-client-${crypto.randomUUID()}`;
    const payload = { conversation: { id }, messages: baseHistory };
    const first = await service.rememberAffinity({ ...args, payload });
    const pool = await db.modelPool.create({
      data: { userId: row.owner.id, name: "Other pool", slug: crypto.randomUUID() },
    });
    const foreign = await fixture();
    const variants = [
      { label: "tenant", ownerId: row.otherTenant.id },
      { label: "owner and tenant", ...argsFor(foreign) },
      { label: "grant", accessGrantId: "different-grant" },
      { label: "pool", poolId: pool.id },
      { label: "target", target: row.target(1) },
      { label: "surface", surface: "anthropic-messages" },
      { label: "token", securityScope: "other-token" },
    ];
    const ids = new Set([first!.sessionId]);
    const originalRows = await db.cacheAffinityRecord.findMany({
      where: { poolId: args.poolId, tenantUserId: args.ownerId },
      orderBy: { id: "asc" },
    });
    const originalNodes = await db.cacheAffinityNode.findMany({
      where: { sessionId: first!.sessionId },
      orderBy: { id: "asc" },
    });
    for (const { label, ...change } of variants) {
      const request = { ...args, ...change, payload };
      const ranked = await service.rankAffinityTargets({
        ...request,
        targets: [request.target],
        scoreSingleTarget: true,
      });
      expect(Object.values(ranked.matchedSessionIds ?? {}), label).not.toContain(first!.sessionId);
      expect(ranked.prefixDepths[request.target.executionTargetId], label).toBe(0);
      expect(ranked.conversationMatches[request.target.executionTargetId], label).toBe(false);
      const result = await service.rememberAffinity(request);
      expect(result!.sessionId, label).not.toBe(first!.sessionId);
      ids.add(result!.sessionId);
      expect(
        await db.cacheAffinityRecord.findMany({
          where: { sessionId: first!.sessionId },
          orderBy: { id: "asc" },
        }),
        label,
      ).toEqual(originalRows);
      expect(
        await db.cacheAffinityNode.findMany({
          where: { sessionId: first!.sessionId },
          orderBy: { id: "asc" },
        }),
        label,
      ).toEqual(originalNodes);
    }
    expect(ids.size).toBe(variants.length + 1);
    const model = await db.executionTarget.findUniqueOrThrow({
      where: { id: args.target.executionTargetId },
    });
    await db.poolMember.create({
      data: {
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
        discoveredModelId: model.discoveredModelId,
      },
    });
    await db.responseStickinessRecord.create({
      data: {
        userId: args.resourceOwnerId,
        routingKeyDigest: `response-${crypto.randomUUID()}`,
        routingVersion: 2,
        targetModelPoolId: args.poolId,
        selectedExecutionTargetId: args.target.executionTargetId,
        selectedDiscoveredModelId: model.discoveredModelId,
        warmSessionId: first!.sessionId,
        warmBindingDigest: first!.bindingDigest,
        warmRootDigest: first!.rootDigest,
        warmTipDigest: first!.tipDigest,
        warmTipDepth: first!.tipDepth,
        warmCanonicalBytes: first!.canonicalBytes,
        warmEstimatedTokens: first!.estimatedTokens,
        expiresAt: new Date(args.now.getTime() + 60000),
      },
    });
    // row_to_json scans every column, including all text columns; no raw carrier may persist.
    const stored = await db.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM cache_affinity_record r WHERE strpos(row_to_json(r)::text, ${id}) > 0
        UNION ALL SELECT 1 FROM cache_affinity_node n WHERE strpos(row_to_json(n)::text, ${id}) > 0
        UNION ALL SELECT 1 FROM response_stickiness_record s WHERE strpos(row_to_json(s)::text, ${id}) > 0
      ) AS present`;
    expect(stored).toEqual([{ present: false }]);
  });

  it.each(["x".repeat(257), "bad#charset", "", 3, [], {}, { wrong: "id" }])(
    "invalid client id %# uses fresh starter/prefix continuation without throwing",
    async (conversation) => {
      const args = argsFor(await fixture());
      const starter = { ...args, payload: { messages: [u("same")], conversation } };
      const one = await service.rememberAffinity(starter);
      const two = await service.rememberAffinity(starter);
      expect(one!.sessionId).not.toBe(two!.sessionId);
      const continuation = await service.rememberAffinity({
        ...args,
        payload: { messages: [u("same"), a("reply")], conversation },
      });
      expect([one!.sessionId, two!.sessionId]).toContain(continuation!.sessionId);
    },
  );

  it("body/header carriers agree; an authoritative id survives root changes with one tip and 64 nodes", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    const first = await service.rememberAffinity({
      ...args,
      payload: { conversation: "stable-id", messages: baseHistory },
    });
    const result = await service.rememberAffinity({
      ...args,
      headers: new Headers({ "SESSION-ID": "stable-id" }),
      payload: {
        messages: [{ role: "system", content: "new instructions" }, ...baseHistory],
      },
    });
    expect(result!.sessionId).toBe(first!.sessionId);
    expect(result!.rootDigest).not.toBe(first!.rootDigest);
    expect(
      await db.cacheAffinityNode.count({ where: { sessionId: first!.sessionId, isTip: true } }),
    ).toBe(1);
    const last = await service.rememberAffinity({
      ...args,
      payload: {
        conversation_id: "stable-id",
        messages: Array.from({ length: 80 }, (_, i) => u(`new ${i}`)),
      },
    });
    expect(last!.sessionId).toBe(first!.sessionId);
    expect(await db.cacheAffinityNode.count({ where: { sessionId: first!.sessionId } })).toBe(64);
    expect(
      await db.cacheAffinityNode.count({ where: { sessionId: first!.sessionId, isTip: true } }),
    ).toBe(1);
    const ranked = await service.rankAffinityTargets({
      ...args,
      payload: { prompt_cache_key: "stable-id", messages: [u("another root")] },
      targets: [args.target],
      scoreSingleTarget: true,
    });
    expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(first!.sessionId);
    expect(ranked.conversationMatches[args.target.executionTargetId]).toBe(true);
    // Prefix-only requests can join authoritative sessions through their committed nodes.
    const joined = await service.rememberAffinity({
      ...args,
      payload: { messages: [...Array.from({ length: 80 }, (_, i) => u(`new ${i}`)), a("reply")] },
    });
    expect(joined!.sessionId).toBe(first!.sessionId);
  });

  it("bound Responses uses a conflicting client id authoritatively, while seeding only server lineage", async () => {
    if (!db) return;
    const args = { ...argsFor(await fixture()), surface: "openai-responses" };
    const parent = await service.rememberAffinity({
      ...args,
      payload: { input: "start", conversation: "parent-id" },
    });
    const nextRequest = {
      ...args,
      sessionBinding: parent!,
      payload: {
        input: "delta",
        previous_response_id: "response",
        prompt_cache_key: "override-id",
        sessionBinding: { sessionId: "forged" },
        warmSessionId: "forged",
      },
    };
    // Forged fields are ordinary unknown semantics and cannot become trusted lineage.
    const next = await service.rememberAffinity({
      ...nextRequest,
      payload: {
        input: "delta",
        previous_response_id: "response",
        prompt_cache_key: "override-id",
      },
    });
    const material = service.affinityPrefixDigests({
      ...args,
      payload: { input: "different start", conversation: "override-id" },
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(next!.sessionId).toBe(material.clientSessionId);
    expect(next!.sessionId).not.toBe(parent!.sessionId);
    expect(next!.rootDigest).toBe(parent!.rootDigest);
    expect(next!.tipDepth).toBe(parent!.tipDepth + 1);
  });

  it("AC-75 changed native instructions keep the client footprint without publishing delta lineage", async () => {
    if (!db) return;
    const args = { ...argsFor(await fixture()), surface: "openai-responses" };
    const parent = await service.rememberAffinity({
      ...args,
      payload: { input: "start", instructions: "old", conversation: "client-id" },
    });
    const request = {
      ...args,
      sessionBinding: parent!,
      payload: {
        input: "delta",
        previous_response_id: "parent",
        instructions: "new",
        conversation: "client-id",
      },
    };
    const material = service.affinityPrefixDigests({
      ...request,
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(material.clientSessionId).toBe(parent!.sessionId);
    expect(material.missingParent).toBe(true);
    expect(material.nodes).toEqual([]);
    expect(await service.rememberAffinity(request)).toBeNull();
    expect(await db.cacheAffinityNode.count({ where: { sessionId: parent!.sessionId } })).toBe(1);
    const rows = await db.cacheAffinityRecord.findMany({ where: { poolId: args.poolId } });
    expect(rows.every((row) => row.sessionId === parent!.sessionId)).toBe(true);
  });

  it.each(["omitted", "same", "changed"] as const)(
    "R1 bound instruction hints %s",
    async (mode) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const createPayload = { instructions: "rules", input: "create" };
      const createMaterial = service.affinityPrefixDigests({
        ...args,
        payload: createPayload,
        runtimeIdentity: args.target.targetIdentity,
      });
      let parent = await service.rememberAffinity({ ...args, payload: createPayload });
      const originalSession = parent!.sessionId;
      const originalRoot = parent!.rootDigest;
      const count = mode === "changed" ? 1 : 80;
      for (let turn = 1; turn <= count; turn++) {
        const payload = {
          input: `delta ${turn}`,
          previous_response_id: `parent-${turn}`,
          ...(mode === "omitted" ? {} : { instructions: mode === "same" ? "rules" : "new rules" }),
        };
        const next = await service.rememberAffinity({ ...args, payload, sessionBinding: parent! });
        if (mode === "changed") {
          expect(next).toBeNull();
          expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(1);
          const deltaMaterial = service.affinityPrefixDigests({
            ...args,
            payload,
            sessionBinding: parent!,
            runtimeIdentity: args.target.targetIdentity,
          });
          expect(deltaMaterial.rootDigest).not.toBe(originalRoot);
          expect(deltaMaterial.routingNodes).toEqual([]);
        } else {
          expect(next!.sessionId).toBe(originalSession);
          expect(next!.rootDigest).toBe(originalRoot);
          parent = next;
        }
        expect(
          await db.cacheAffinityRecord.count({
            where: { poolId: args.poolId, prefixDigest: createMaterial.instructionDigests[0] },
          }),
        ).toBe(1);
      }
      const rows = await db.cacheAffinityRecord.findMany({ where: { poolId: args.poolId } });
      if (mode === "changed")
        expect(rows).toHaveLength(4); // old instruction/node/footprint plus new instruction
      else {
        expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(64);
        expect(rows).toHaveLength(66); // 64 matchable chain hints, instruction and footprint
        const nodes = await db.cacheAffinityNode.findMany({ where: { poolId: args.poolId } });
        expect(
          rows
            .filter(
              (row) =>
                row.prefixDigest !== null &&
                row.prefixDigest !== createMaterial.instructionDigests[0],
            )
            .map((row) => row.prefixDigest)
            .sort(),
        ).toEqual(nodes.map((node) => node.nodeDigest).sort());
      }
      const ranked = await service.rankAffinityTargets({
        ...args,
        payload: { instructions: "rules", input: "different starter" },
        targets: [args.target],
        scoreSingleTarget: true,
      });
      expect(ranked.instructionDepths?.[args.target.executionTargetId]).toBe(1);
    },
  );

  it("C2-4/C2-5 bound turns retain committed size in every warm window and only matchable tail rows", async () => {
    if (!db) return;
    const args = {
      ...argsFor(await fixture()),
      surface: "openai-responses",
      policy: { ...policy, ttlSeconds: 7200 },
    };
    let parent = await service.rememberAffinity({
      ...args,
      payload: { input: "create" },
      estimatedTokens: 20000,
    });
    let previousCount = 0;
    for (let turn = 1; turn <= 80; turn++) {
      const now = new Date(args.now.getTime() + turn * 60000);
      const payload = { input: `delta ${turn}`, previous_response_id: `unique-parent-${turn}` };
      const material = service.affinityPrefixDigests({
        ...args,
        payload,
        sessionBinding: parent!,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(material.rootDigest).toBe(parent!.rootDigest);
      const next = await service.rememberAffinity({
        ...args,
        now,
        payload,
        sessionBinding: parent!,
        estimatedDeltaTokens: 10,
      });
      expect(next!.sessionId).toBe(parent!.sessionId);
      expect(next!.estimatedTokens).toBe(20000 + turn * 10);
      const sessions =
        (
          await warm.loadWarmSessions({
            ownerId: args.resourceOwnerId,
            capacityIds: [args.target.capacityId],
            policy: { windowSeconds: 300, minTokens: 8192 },
            now,
          })
        ).get(args.target.capacityId) ?? [];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.tokens).toBe(next!.estimatedTokens);
      const count = await db.cacheAffinityRecord.count({ where: { poolId: args.poolId } });
      expect(count).toBe(Math.min(64, turn + 1) + 1);
      if (turn >= 64) expect(count).toBe(previousCount);
      previousCount = count;
      parent = next;
    }
  }, 60000);

  it("C3b-1 with ids: marking one identical conversation in flight leaves the other PROTECTED in slot mode", async () => {
    if (!db) return;
    const row = await fixture();
    const args = argsFor(row);
    const sessions = await Promise.all(
      ["one", "two"].map((conversation) =>
        service.rememberAffinity({
          ...args,
          payload: { messages: baseHistory, conversation },
          estimatedTokens: 20000,
        }),
      ),
    );
    const model = await db.executionTarget.findUniqueOrThrow({
      where: { id: args.target.executionTargetId },
    });
    const member = await db.poolMember.create({
      data: {
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
        discoveredModelId: model.discoveredModelId,
      },
    });
    const id = crypto.randomUUID();
    const request = await db.admissionRequest.create({
      data: {
        userId: row.owner.id,
        requestId: id,
        attemptId: id,
        sourceKind: "POOL",
        poolId: args.poolId,
        basePriority: 16,
        enqueueSequence: 1n,
        connectionOwner: "identity-test",
        heartbeatAt: args.now,
        state: "ADMITTED",
        warmSessionIds: [sessions[0]!.sessionId],
      },
    });
    await db.capacityLease.create({
      data: {
        userId: row.owner.id,
        admissionRequestId: request.id,
        requestId: id,
        attemptId: id,
        capacityId: args.target.capacityId,
        executionTargetId: args.target.executionTargetId,
        poolId: args.poolId,
        poolMemberId: member.id,
        priority: 16,
        reservationClass: 0,
        fencingToken: 1n,
        ownerServerInstance: "identity-test",
        acquiredAt: args.now,
        heartbeatAt: args.now,
        expiresAt: new Date(args.now.getTime() + 60000),
      },
    });
    const protection = {
      enabled: true,
      windowSeconds: 300,
      minTokens: 8192,
      share: "EQUAL_SHARE" as const,
      fixedPercent: null,
    };
    const loaded =
      (
        await warm.loadWarmSessions({
          ownerId: row.owner.id,
          capacityIds: [args.target.capacityId],
          policy: protection,
          now: args.now,
        })
      ).get(args.target.capacityId) ?? [];
    expect(loaded).toHaveLength(2);
    expect(loaded.filter((session) => session.inFlight)).toHaveLength(1);
    const load = { slots: 2, active: 1, kvBudgetTokens: null };
    expect(
      warm.memberProtectionVerdict({
        load,
        protectedSessions: warm.protectedWarmSessions(loaded, load, protection),
        requestTokens: 20000,
        affine: false,
      }),
    ).toMatchObject({ state: "PROTECTED", idleProtectedSessions: 1 });
  });

  it("C2-6 N=32 concurrent fenced completions have a bounded latency (p50/p99)", async () => {
    const args = argsFor(await fixture());
    const durations = await Promise.all(
      Array.from({ length: 32 }, async (_, i) => {
        const start = performance.now();
        const result = await service.rememberAffinity({
          ...args,
          payload: { conversation: `completion-${i}`, messages: baseHistory },
        });
        expect(result).not.toBeNull();
        return performance.now() - start;
      }),
    );
    durations.sort((a, b) => a - b);
    process.stdout.write(
      `[cache-affinity C2-6] N=32 p50=${durations[15]!.toFixed(1)}ms p99=${durations[31]!.toFixed(1)}ms\n`,
    );
    expect(durations[31]).toBeLessThan(10000);
  }, 20000);

  it("C2-6 a contended fence times out and rolls back without a committed warm link", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    let release: (() => void) | undefined;
    let acquired: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT wsmp_acquire_fences(ARRAY[${`09:cache-affinity:${args.resourceOwnerId}:${args.poolId}`}]::text[], true)`;
        acquired!();
        await hold;
      },
      { timeout: 10000 },
    );
    await ready;
    const start = performance.now();
    try {
      await expect(
        service.rememberAffinity({
          ...args,
          payload: { conversation: "timed-out", messages: baseHistory },
        }),
      ).rejects.toThrow();
      expect(performance.now() - start).toBeLessThan(6000);
      expect(await db.cacheAffinityRecord.count({ where: { poolId: args.poolId } })).toBe(0);
      expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(0);
    } finally {
      release!();
      await blocking;
    }
  }, 15000);

  it.each(["edit", "truncate"] as const)(
    "%s: sole ancestor continues, several owners fail closed",
    async (kind) => {
      if (!db) return;
      const args = argsFor(await fixture());
      const write = (messages: unknown[]) =>
        service.rememberAffinity({ ...args, payload: { messages } });
      const first = await write(baseHistory);
      const changed =
        kind === "edit"
          ? [u("shared starter"), a("reply"), u("edited next")]
          : [u("shared starter"), a("reply")];
      expect((await write(changed))!.sessionId).toBe(first!.sessionId);
      // Restore and add a second owner through an identical fresh starter.
      await write(baseHistory);
      const sibling = await write([u("shared starter")]);
      // Seed an independently advanced sibling sharing the ancestor. This state
      // can also come from exact Responses lineage; plain history cannot assert it.
      const material = service.affinityPrefixDigests({
        ...args,
        runtimeIdentity: args.target.targetIdentity,
        payload: { messages: [u("shared starter"), a("reply"), u("different next")] },
      });
      await db.cacheAffinityNode.updateMany({
        where: { sessionId: sibling!.sessionId },
        data: { isTip: false },
      });
      await db.cacheAffinityNode.createMany({
        data: material.nodes.slice(1).map((node, i) => ({
          userId: args.resourceOwnerId,
          tenantUserId: args.ownerId,
          poolId: args.poolId,
          executionTargetId: args.target.executionTargetId,
          rootDigest: material.rootDigest,
          nodeDigest: node.digest,
          depth: node.depth,
          sessionId: sibling!.sessionId,
          isTip: i === 1,
          expiresAt: new Date(args.now.getTime() + 60000),
        })),
      });
      const result = await write(changed);
      expect(result!.sessionId).not.toBe(first!.sessionId);
      expect(result!.sessionId).not.toBe(sibling!.sessionId);
    },
  );

  it("truncation to a shared user-only starter fails closed", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    const write = (messages: unknown[]) =>
      service.rememberAffinity({ ...args, payload: { messages } });
    const [one, two] = await Promise.all([
      write([u("shared starter")]),
      write([u("shared starter")]),
    ]);
    await write(baseHistory);
    await write([u("shared starter"), a("Y"), u("Y2")]);
    const shortened = await write([u("shared starter")]);
    expect(shortened!.sessionId).not.toBe(one!.sessionId);
    expect(shortened!.sessionId).not.toBe(two!.sessionId);
  });

  it.each(["openai-chat", "anthropic-messages", "openai-responses"])(
    "R1 documented limit few-shot edits merge on %s",
    async (surface) => {
      const args = { ...argsFor(await fixture()), surface };
      const results: string[] = [];
      for (const query of ["X", "Y", "X next", "Y next"]) {
        const units = [u("example"), a("label"), u(query)];
        const result = await service.rememberAffinity({
          ...args,
          payload: surface === "openai-responses" ? { input: units } : { messages: units },
        });
        results.push(result!.sessionId);
      }
      expect(new Set(results).size).toBe(1);
    },
  );

  const protocols = ["openai-chat", "anthropic-messages", "openai-responses"] as const;
  function payloadFor(surface: (typeof protocols)[number], extra: Record<string, unknown> = {}) {
    return surface === "openai-responses"
      ? { instructions: "rules", input: baseHistory, tools: [], ...extra }
      : surface === "anthropic-messages"
        ? { system: "rules", messages: baseHistory, tools: [], ...extra }
        : { messages: [{ role: "system", content: "rules" }, ...baseHistory], tools: [], ...extra };
  }
  const r1HeaderCases = protocols.flatMap((surface) =>
    [
      "x-conversation-id",
      "session_id",
      "session-id",
      "x-session-id",
      "x-claude-code-session-id",
    ].map((header) => ({ surface, header })),
  );
  it.each(r1HeaderCases)("R1 header carrier PG $surface $header", async ({ surface, header }) => {
    const args = {
      ...argsFor(await fixture()),
      surface,
      headers: new Headers({ [header.toUpperCase()]: " stable-client " }),
    };
    const before = payloadFor(surface, {
      metadata: { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" },
    });
    const after = payloadFor(surface, {
      metadata: { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" },
      unknown_extension: "changed",
    });
    const first = await service.rememberAffinity({ ...args, payload: before });
    const expected = service.affinityPrefixDigests({
      ...args,
      headers: undefined,
      payload: payloadFor(surface, { conversation: "stable-client" }),
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(first!.sessionId).toBe(expected.clientSessionId);
    const ranked = await service.rankAffinityTargets({
      ...args,
      payload: after,
      targets: [args.target],
      scoreSingleTarget: true,
    });
    expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(first!.sessionId);
    const next = await service.rememberAffinity({ ...args, payload: after });
    expect(next!.sessionId).toBe(first!.sessionId);
    expect(next!.rootDigest).not.toBe(first!.rootDigest);
    const material = service.affinityPrefixDigests({
      ...args,
      payload: after,
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(material.clientSessionId).toBe(first!.sessionId);
  });

  const r1CarrierCases = protocols.flatMap((surface) => [
    ...["conversation", "conversation_id"].flatMap((key) => [
      {
        surface,
        name: `${key} valid`,
        before: { [key]: "client" },
        after: { [key]: " client " },
        free: true,
        client: true,
      },
      {
        surface,
        name: `${key} object`,
        before: { [key]: { id: "client", note: "A" } },
        after: { [key]: { id: "client", note: "B" } },
        free: true,
        client: true,
      },
      {
        surface,
        name: `${key} invalid`,
        before: { [key]: "bad key A" },
        after: { [key]: "bad key B" },
        free: false,
        client: false,
      },
    ]),
    {
      surface,
      name: "prompt_cache_key valid or inactive",
      before: { prompt_cache_key: "client" },
      after: { prompt_cache_key: " client " },
      free: surface !== "anthropic-messages",
      client: surface !== "anthropic-messages",
    },
    {
      surface,
      name: "prompt_cache_key invalid",
      before: { prompt_cache_key: "bad key A" },
      after: { prompt_cache_key: "bad key B" },
      free: false,
      client: false,
    },
    {
      surface,
      name: "ordinary metadata.user_id",
      before: { metadata: { user_id: "user-A" } },
      after: { metadata: { user_id: "user-B" } },
      free: false,
      client: false,
    },
    {
      surface,
      name: "metadata session token valid or inactive",
      before: { metadata: { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" } },
      after: { metadata: { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" } },
      free: surface === "anthropic-messages",
      client: surface === "anthropic-messages",
    },
    {
      surface,
      name: "other metadata fields",
      before: {
        metadata: { user_id: "user_session_11111111-2222-4333-8444-555555555555", extra: "A" },
      },
      after: {
        metadata: { user_id: "user_session_11111111-2222-4333-8444-555555555555", extra: "B" },
      },
      free: false,
      client: surface === "anthropic-messages",
    },
    ...["conversation_id", "prompt_cache_key", "metadata"].map((key) => ({
      surface,
      name: `${key} losing carrier`,
      before: {
        conversation: "winner",
        [key]:
          key === "metadata"
            ? { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" }
            : "A",
      },
      after: {
        conversation: "winner",
        [key]:
          key === "metadata"
            ? { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" }
            : "B",
      },
      free: false,
      client: true,
    })),
  ]);
  it.each(r1CarrierCases)(
    "R1 carrier PG $surface $name",
    async ({ surface, before, after, free, client }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const firstPayload = payloadFor(surface, before);
      const nextPayload = payloadFor(surface, after);
      const one = service.affinityPrefixDigests({
        ...args,
        payload: firstPayload,
        runtimeIdentity: args.target.targetIdentity,
      });
      const two = service.affinityPrefixDigests({
        ...args,
        payload: nextPayload,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(two.rootDigest === one.rootDigest).toBe(free);
      const first = await service.rememberAffinity({ ...args, payload: firstPayload });
      const ranked = await service.rankAffinityTargets({
        ...args,
        payload: nextPayload,
        targets: [args.target],
        scoreSingleTarget: true,
      });
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId] === first!.sessionId).toBe(
        client || free,
      );
      const next = await service.rememberAffinity({ ...args, payload: nextPayload });
      expect(next!.sessionId === first!.sessionId).toBe(client || free);
      if (client) {
        const changed = await service.rememberAffinity({
          ...args,
          payload: { ...nextPayload, unknown_extension: "changed" },
        });
        expect(changed!.rootDigest).not.toBe(first!.rootDigest);
        expect(changed!.sessionId).toBe(first!.sessionId);
      }
    },
  );

  it.each(protocols)(
    "%s: sampling free; instructions/tools/semantic and unknown params bind",
    async (surface) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface };
      const original = await service.rememberAffinity({ ...args, payload: payloadFor(surface) });
      for (const key of [
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "typical_p",
        "seed",
        "frequency_penalty",
        "presence_penalty",
        "repetition_penalty",
        "logit_bias",
        "stop",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "n",
        "best_of",
      ]) {
        const payload = payloadFor(surface, {
          [key]: key === "stop" ? ["END"] : key === "logit_bias" ? { "1": 1 } : 0.7,
        });
        expect((await service.rememberAffinity({ ...args, payload }))!.sessionId, key).toBe(
          original!.sessionId,
        );
      }
      const instruction =
        surface === "openai-chat"
          ? { messages: [{ role: "system", content: "changed" }, ...baseHistory] }
          : surface === "openai-responses"
            ? { instructions: "changed" }
            : { system: "changed" };
      for (const change of [
        instruction,
        { tools: [{ name: "changed" }] },
        { response_format: { type: "json_object" } },
        { text: { format: { type: "json_object" } } },
        { tool_choice: "required" },
        { parallel_tool_calls: false },
        { reasoning: { effort: "high" } },
        { unknown_extension: "changed" },
      ]) {
        const result = await service.rememberAffinity({
          ...args,
          payload: payloadFor(surface, change),
        });
        expect(result!.sessionId, JSON.stringify(change)).not.toBe(original!.sessionId);
      }
    },
  );

  it("isolates security scopes while retaining identity across root changes with an explicit id", async () => {
    if (!db) return;
    const row = await fixture();
    const args = argsFor(row);
    const payload = { messages: baseHistory, conversation_id: "same-explicit-id" };
    const original = await service.rememberAffinity({ ...args, payload });
    const pool = await db.modelPool.create({
      data: { userId: row.owner.id, name: "Other", slug: `other-${crypto.randomUUID()}` },
    });
    for (const change of [
      { ownerId: row.otherTenant.id },
      { securityScope: "other-token" },
      { accessGrantId: "other-grant" },
      { poolId: pool.id },
      { target: row.target(1) },
      { target: { ...args.target, targetIdentity: "other-runtime" } },
      { surface: "anthropic-messages" },
      { payload: { ...payload, tools: [{ name: "other" }] } },
    ]) {
      const result = await service.rememberAffinity({ ...args, payload, ...change });
      if ("payload" in change) expect(result!.sessionId).toBe(original!.sessionId);
      else expect(result!.sessionId).not.toBe(original!.sessionId);
    }
  });

  it.each([
    { name: "earlier expiry has larger id", expires: { a: 120000, z: 60000 }, winner: "z" },
    { name: "earlier expiry has smaller id", expires: { a: 60000, z: 120000 }, winner: "a" },
    { name: "equal expiry uses session id", expires: { a: 60000, z: 60000 }, winner: "a" },
  ])("AC-59 $name, stable across insertion order and repeats", async ({ expires, winner }) => {
    if (!db) return;
    const args = argsFor(await fixture());
    const material = service.affinityPrefixDigests({
      ...args,
      runtimeIdentity: args.target.targetIdentity,
      payload: { messages: baseHistory },
    });
    const scope = {
      userId: args.resourceOwnerId,
      tenantUserId: args.ownerId,
      poolId: args.poolId,
      executionTargetId: args.target.executionTargetId,
    };
    for (const order of [
      ["z", "a"],
      ["a", "z"],
    ] as const) {
      await db.cacheAffinityNode.deleteMany({ where: { poolId: args.poolId } });
      for (const sessionId of order) {
        await db.cacheAffinityNode.create({
          data: {
            ...scope,
            rootDigest: material.rootDigest,
            nodeDigest: material.nodes.at(-1)!.digest,
            depth: 3,
            sessionId,
            isTip: true,
            expiresAt: new Date(args.now.getTime() + expires[sessionId]),
          },
        });
      }
      for (let i = 0; i < 3; i++) {
        expect(await service.resolveAffinitySession(db, scope, material, args.now)).toBe(winner);
        const ranked = await service.rankAffinityTargets({
          ...args,
          payload: { messages: baseHistory },
          targets: [args.target],
          scoreSingleTarget: true,
        });
        expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(winner);
      }
    }
  });

  it("native delta seeds the durable parent; missing binding or changed instructions never probes unrelated starters", async () => {
    if (!db) return;
    const args = { ...argsFor(await fixture()), surface: "openai-responses" };
    const unrelated = await service.rememberAffinity({ ...args, payload: { input: "delta" } });
    const parent = await service.rememberAffinity({ ...args, payload: { input: "parent" } });
    const payload = { input: "delta", previous_response_id: "parent_response" };
    const continued = await service.rememberAffinity({ ...args, payload, sessionBinding: parent! });
    expect(continued!.sessionId).toBe(parent!.sessionId);
    expect(continued!.tipDigest).not.toBe(unrelated!.tipDigest);
    const missing = await service.rememberAffinity({ ...args, payload });
    expect(missing).toBeNull();
    expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(3);
    expect(
      await service.rememberAffinity({
        ...args,
        payload: { ...payload, instructions: "changed" },
        sessionBinding: parent!,
      }),
    ).toBeNull();
  });

  it.each(
    ["openai-chat", "anthropic-messages", "openai-responses"].flatMap((surface) =>
      [false, true].map((client) => ({ surface, client })),
    ),
  )(
    "R1 over-cap vision routing and protection PG $surface client=$client",
    async ({ surface, client }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface, policy: { ...policy, ttlSeconds: 900 } };
      const headers = client
        ? new Headers({ "x-claude-code-session-id": "vision-client" })
        : undefined;
      const content = Array.from({ length: 80 }, (_, i) =>
        i % 2 ? a(`turn ${i}`) : u(`turn ${i}`),
      );
      const image = {
        role: "user",
        content: (client ? [0.9, 1.3] : [2]).map((size) => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${"A".repeat(Math.ceil(size * 1024 * 1024))}` },
        })),
      };
      const protection = {
        enabled: true,
        windowSeconds: 300,
        minTokens: 8192,
        share: "EQUAL_SHARE" as const,
        fixedPercent: null,
      };
      let clientSessionId: string | undefined;
      for (let turn = 0; turn < 3; turn++) {
        // Refresh repeatedly across a full protection window; omitted footprint
        // refresh or hints lost to byte refusal would expire by the third turn.
        const now = new Date(args.now.getTime() + turn * 250_000);
        const units = [
          ...content,
          image,
          ...Array.from({ length: turn }, (_, i) => [a(`answer ${i}`), u(`next ${i}`)]).flat(),
        ];
        const payload =
          surface === "openai-responses"
            ? { instructions: "rules", input: units }
            : surface === "anthropic-messages"
              ? { system: "rules", messages: units }
              : { messages: [{ role: "system", content: "rules" }, ...units] };
        const material = service.affinityPrefixDigests({
          ...args,
          payload,
          headers,
          runtimeIdentity: args.target.targetIdentity,
        });
        expect(material.identifiable).toBe(false);
        expect(material.nodes).toEqual([]);
        expect(material.routingNodes).toHaveLength(64);
        expect(material.instructionDigests).toHaveLength(1);
        if (client) {
          clientSessionId ??= material.clientSessionId;
          expect(material.clientSessionId).toBe(clientSessionId);
        } else expect(material.clientSessionId).toBeUndefined();
        expect(
          await service.rememberAffinity({
            ...args,
            now,
            payload,
            headers,
            estimatedTokens: 20000 + turn,
          }),
        ).toBeNull();
        expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(0);
        const rows = await db.cacheAffinityRecord.findMany({ where: { poolId: args.poolId } });
        expect(rows.filter((row) => row.prefixDigest === null)).toHaveLength(client ? 1 : 0);
        expect(rows).toHaveLength(client ? 66 : 65);
        if (client) expect(rows.every((row) => row.sessionId === clientSessionId)).toBe(true);
        const ranked = await service.rankAffinityTargets({
          ...args,
          now,
          payload,
          headers,
          targets: [args.target],
          scoreSingleTarget: true,
        });
        expect(ranked.prefixDepths[args.target.executionTargetId]).toBe(80);
        expect(ranked.instructionDepths?.[args.target.executionTargetId]).toBe(1);
        expect(service.isAffinityTargetWarm(ranked, args.target.executionTargetId)).toBe(true);
        expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(
          client ? clientSessionId : undefined,
        );
        const loaded =
          (
            await warm.loadWarmSessions({
              ownerId: args.resourceOwnerId,
              capacityIds: [args.target.capacityId],
              policy: protection,
              now,
            })
          ).get(args.target.capacityId) ?? [];
        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.tokens).toBe(20000 + turn);
        const load = { slots: 1, active: 0, kvBudgetTokens: null };
        expect(
          warm.memberProtectionVerdict({
            load,
            protectedSessions: warm.protectedWarmSessions(loaded, load, protection),
            requestTokens: 20000,
            affine: false,
          }).state,
        ).toBe("PROTECTED");
        expect(
          warm.memberProtectionVerdict({
            load,
            protectedSessions: loaded,
            requestTokens: 20000,
            affine: true,
          }).state,
        ).toBe("FREE");
      }
    },
  );

  it.each([false, true])("R1 missing-parent delta routing PG client=%s", async (client) => {
    if (!db) return;
    const args = { ...argsFor(await fixture()), surface: "openai-responses" };
    const payload = {
      instructions: "rules",
      input: [u("delta"), a("output")],
      previous_response_id: "missing",
      ...(client ? { conversation: "client" } : {}),
    };
    const material = service.affinityPrefixDigests({
      ...args,
      payload,
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(material.missingParent).toBe(true);
    expect(material.instructionDigests).toHaveLength(1);
    expect(await service.rememberAffinity({ ...args, payload })).toBeNull();
    expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(0);
    const rows = await db.cacheAffinityRecord.findMany({ where: { poolId: args.poolId } });
    expect(rows.filter((row) => row.prefixDigest !== null).map((row) => row.prefixDigest)).toEqual(
      material.instructionDigests,
    );
    expect(rows).toHaveLength(client ? 2 : 1);
  });

  it("retains the true tip beyond 64 units; over cap is fresh without nodes or throwing", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    const messages = Array.from({ length: 90 }, (_, i) => (i % 2 ? a(String(i)) : u(String(i))));
    const first = await service.rememberAffinity({ ...args, payload: { messages } });
    const nodes = await db.cacheAffinityNode.findMany({
      where: { sessionId: first!.sessionId },
      orderBy: { id: "asc" },
    });
    expect(nodes).toHaveLength(64);
    expect(nodes.find((n) => n.isTip)).toMatchObject({ depth: 90, nodeDigest: first!.tipDigest });
    const next = await service.rememberAffinity({
      ...args,
      payload: { messages: [...messages, u("91")] },
    });
    expect(next!.sessionId).toBe(first!.sessionId);
    expect(await db.cacheAffinityNode.count({ where: { sessionId: first!.sessionId } })).toBe(64);
    const huge = await service.rememberAffinity({
      ...args,
      payload: { messages: [...messages, u("x".repeat(2 * 1024 * 1024))] },
    });
    expect(huge).toBeNull();
    expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(64);
  });

  it("rollback after node writes publishes nothing and preserves the earlier tip", async () => {
    if (!db) return;
    const args = argsFor(await fixture());
    const first = await service.rememberAffinity({ ...args, payload: { messages: baseHistory } });
    const before = await db.cacheAffinityNode.findMany({
      where: { poolId: args.poolId },
      orderBy: { id: "asc" },
    });
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_affinity_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."poolId" = '${args.poolId}' AND NEW."prefixDigest" IS NULL THEN RAISE EXCEPTION 'forced after nodes'; END IF; RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_affinity_rollback BEFORE INSERT OR UPDATE ON cache_affinity_record FOR EACH ROW EXECUTE FUNCTION test_affinity_rollback()`,
    );
    try {
      await expect(
        service.rememberAffinity({
          ...args,
          payload: { messages: [...baseHistory, a("later"), u("later")] },
        }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER test_affinity_rollback ON cache_affinity_record`);
      await db.$executeRawUnsafe(`DROP FUNCTION test_affinity_rollback()`);
    }
    expect(
      await db.cacheAffinityNode.findMany({
        where: { poolId: args.poolId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(
      new Set(
        (await db.cacheAffinityRecord.findMany({ where: { poolId: args.poolId } })).map(
          (r) => r.sessionId,
        ),
      ),
    ).toEqual(new Set([first!.sessionId]));
  });

  it("pool clear, expiry and tenant purge remove records and nodes together", async () => {
    if (!db) return;
    const { clearCacheAffinityRecords, purgeDeletedUserHistory } = await import(
      "@ws-model-proxy/db/hot-path-sweeps"
    );
    const args = argsFor(await fixture());
    const write = () => service.rememberAffinity({ ...args, payload: { messages: baseHistory } });
    await write();
    expect(
      await clearCacheAffinityRecords(db, {
        ownerUserId: args.resourceOwnerId,
        poolId: args.poolId,
      }),
    ).toBeGreaterThan(3);
    expect(await db.cacheAffinityRecord.count({ where: { poolId: args.poolId } })).toBe(0);
    expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(0);
    await write();
    await service.sweepExpiredAffinity({ now: new Date(args.now.getTime() + 61000), limit: 10000 });
    expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId } })).toBe(0);
    await write();
    const purged = await purgeDeletedUserHistory(db, args.ownerId);
    expect(purged.remaining).toBe(false);
    expect(await db.cacheAffinityRecord.count({ where: { tenantUserId: args.ownerId } })).toBe(0);
    expect(await db.cacheAffinityNode.count({ where: { tenantUserId: args.ownerId } })).toBe(0);
  });

  it.each([
    { initial: true, evidence: undefined, expected: true },
    { initial: false, evidence: true, expected: true },
    { initial: true, evidence: false, expected: false },
    { initial: false, evidence: undefined, expected: false },
  ])(
    "footprint conflict keeps estimates and applies cache evidence $initial -> $evidence",
    async ({ initial, evidence, expected }) => {
      if (!db) return;
      const args = {
        ...argsFor(await fixture()),
        surface: "openai-responses",
        payload: { input: "starter", conversation: "client" },
      };
      const first = await service.rememberAffinity({
        ...args,
        estimatedTokens: 30000,
        engineCacheConfirmed: initial,
      });
      const now = new Date(args.now.getTime() + 1);
      const next = await service.rememberAffinity({ ...args, now, engineCacheConfirmed: evidence });
      expect(next!.sessionId).toBe(first!.sessionId);
      const rows = await db.cacheAffinityRecord.findMany({
        where: { poolId: args.poolId, prefixDigest: null },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.estimatedTokens).toBe(30000);
        expect(row.engineCacheConfirmed).toBe(expected);
        expect(row.lastUsedAt).toEqual(now);
        expect(row.expiresAt).toEqual(new Date(now.getTime() + policy.ttlSeconds * 1000));
      }
    },
  );

  it.each([
    { name: "lost footprint", footprint: true, survivor: true, retained: false },
    { name: "orphan hint", footprint: false, survivor: false, retained: false },
    { name: "hint with surviving footprint", footprint: false, survivor: true, retained: true },
  ])(
    "retention eviction handles $name without stranding or erasing lineage",
    async ({ footprint, survivor, retained }) => {
      if (!db) return;
      const args = argsFor(await fixture());
      const oldPayload = { messages: [u("old starter")] };
      const material = service.affinityPrefixDigests({
        ...args,
        runtimeIdentity: args.target.targetIdentity,
        payload: oldPayload,
      });
      const scope = {
        userId: args.resourceOwnerId,
        tenantUserId: args.ownerId,
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
      };
      const sessionId = `old-${args.poolId}`;
      await db.cacheAffinityNode.create({
        data: {
          ...scope,
          sessionId,
          rootDigest: material.rootDigest,
          nodeDigest: material.nodes[0]!.digest,
          depth: 1,
          isTip: true,
          expiresAt: new Date(args.now.getTime() + 60000),
        },
      });
      const record = {
        ...scope,
        sessionId,
        targetIdentity: args.target.targetIdentity,
        bindingDigest: material.bindingDigest,
        prefixDepth: 0,
        digestVersion: 5,
        expiresAt: new Date(args.now.getTime() + 60000),
      };
      const evicted = await db.cacheAffinityRecord.create({
        data: {
          ...record,
          lastUsedAt: new Date(args.now.getTime() - 1),
          ...(footprint
            ? { conversationDigest: "o".repeat(32) }
            : { prefixDigest: material.nodes[0]!.digest, prefixDepth: 1 }),
        },
      });
      if (survivor)
        await db.cacheAffinityRecord.create({
          data: {
            ...record,
            lastUsedAt: new Date(args.now.getTime() + 1),
            conversationDigest: "s".repeat(32),
          },
        });
      await service.rememberAffinity({
        ...args,
        payload: { messages: [u("fresh starter")] },
        policy: { ...policy, maxRecords: 2 + Number(survivor) },
      });
      expect(await db.cacheAffinityRecord.findUnique({ where: { id: evicted.id } })).toBeNull();
      expect(await db.cacheAffinityNode.count({ where: { poolId: args.poolId, sessionId } })).toBe(
        Number(retained),
      );
      const continuation = service.affinityPrefixDigests({
        ...args,
        runtimeIdentity: args.target.targetIdentity,
        payload: { messages: [...oldPayload.messages, a("reply"), u("next")] },
      });
      expect(await service.resolveAffinitySession(db, scope, continuation, args.now)).toBe(
        retained ? sessionId : null,
      );
    },
  );

  it.each(
    [true, false].flatMap((isTip) =>
      ["userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "expired"].map(
        (column) => ({ isTip, column }),
      ),
    ),
  )("7.1-7.11 forged probe isTip=$isTip foreign $column cannot join", async ({ isTip, column }) => {
    if (!db) return;
    const row = await fixture();
    const args = argsFor(row);
    const payload = { messages: baseHistory };
    const material = service.affinityPrefixDigests({
      ...args,
      payload,
      runtimeIdentity: args.target.targetIdentity,
    });
    const scope = {
      userId: args.resourceOwnerId,
      tenantUserId: args.ownerId,
      poolId: args.poolId,
      executionTargetId: args.target.executionTargetId,
    };
    const forged = {
      ...scope,
      rootDigest: material.rootDigest,
      nodeDigest: material.nodes[0]!.digest,
      depth: 1,
      sessionId: `forged-${args.poolId}`,
      isTip,
      expiresAt: new Date(args.now.getTime() + 60000),
    };
    if (column === "expired") forged.expiresAt = new Date(args.now.getTime() - 1);
    else if (column === "rootDigest") forged.rootDigest = "r".repeat(43);
    else if (column === "executionTargetId")
      forged.executionTargetId = row.target(1).executionTargetId;
    else if (column === "userId") scope.userId = row.otherTenant.id;
    else if (column === "tenantUserId") forged.tenantUserId = row.otherTenant.id;
    else
      forged.poolId = (
        await db.modelPool.create({
          data: { userId: args.resourceOwnerId, name: "Other pool", slug: `other-${args.poolId}` },
        })
      ).id;
    // Nodes are deliberately inserted directly: their digests mimic the
    // request even though the enclosing scope differs. Target B uses the
    // SAME targetIdentity as A, so the executionTargetId predicate matters.
    await db.cacheAffinityNode.create({ data: forged });
    expect(await service.resolveAffinitySession(producer, scope, material, args.now)).toBeNull();
    // The database enforces pool ownership, so userId is tested with a
    // foreign read scope against a valid owned row, without disabling guards.
    if (column !== "userId") {
      const written = await service.rememberAffinity({ ...args, payload });
      expect(written!.sessionId).not.toBe(forged.sessionId);
    }
  });

  it.each([
    "missing",
    "replaced digest",
    "expired",
    "rootDigest",
    "userId",
    "tenantUserId",
    "poolId",
    "executionTargetId",
  ])("7.13-7.16/13.1 bound parent $0 is rejected", async (column) => {
    if (!db) return;
    const row = await fixture();
    const args = { ...argsFor(row), surface: "openai-responses" };
    const parent = await service.rememberAffinity({ ...args, payload: { input: "create" } });
    const scope = {
      userId: args.resourceOwnerId,
      tenantUserId: args.ownerId,
      poolId: args.poolId,
      executionTargetId: args.target.executionTargetId,
    };
    await db.cacheAffinityNode.deleteMany({ where: { ...scope, sessionId: parent!.sessionId } });
    const forged = {
      ...scope,
      rootDigest: parent!.rootDigest,
      nodeDigest: parent!.tipDigest,
      depth: parent!.tipDepth,
      sessionId: parent!.sessionId,
      isTip: true,
      expiresAt: new Date(args.now.getTime() + 60000),
    };
    if (column === "replaced digest") forged.nodeDigest = "d".repeat(43);
    else if (column === "expired") forged.expiresAt = new Date(args.now.getTime() - 1);
    else if (column === "rootDigest") forged.rootDigest = "r".repeat(43);
    else if (column === "executionTargetId")
      forged.executionTargetId = row.target(1).executionTargetId;
    else if (column === "userId") scope.userId = row.otherTenant.id;
    else if (column === "tenantUserId") forged.tenantUserId = row.otherTenant.id;
    else if (column === "poolId")
      forged.poolId = (
        await db.modelPool.create({
          data: { userId: args.resourceOwnerId, name: "Other pool", slug: `other-${args.poolId}` },
        })
      ).id;
    if (column !== "missing") await db.cacheAffinityNode.create({ data: forged });
    const material = service.affinityPrefixDigests({
      ...args,
      payload: { input: "delta", previous_response_id: "parent" },
      sessionBinding: parent!,
      runtimeIdentity: args.target.targetIdentity,
    });
    expect(material.boundSessionId).toBe(parent!.sessionId);
    expect(await service.resolveAffinitySession(producer, scope, material, args.now)).toBeNull();
    if (column !== "userId") {
      const next = await service.rememberAffinity({
        ...args,
        payload: { input: "delta", previous_response_id: "parent" },
        sessionBinding: parent!,
      });
      expect(next!.sessionId).not.toBe(parent!.sessionId);
    }
  });

  it.each(
    [
      { aExpiry: 20000, zExpiry: 10000, expected: "z" },
      { aExpiry: 10000, zExpiry: 20000, expected: "a" },
      { aExpiry: 10000, zExpiry: 10000, expected: "a" },
    ].flatMap((row) => [false, true].map((reverse) => ({ ...row, reverse }))),
  )(
    "AC-59 tips expiry a=$aExpiry z=$zExpiry reverse=$reverse chooses $expected",
    async ({ aExpiry, zExpiry, expected, reverse }) => {
      if (!db) return;
      const args = argsFor(await fixture());
      const material = service.affinityPrefixDigests({
        ...args,
        payload: { messages: baseHistory },
        runtimeIdentity: args.target.targetIdentity,
      });
      const scope = {
        userId: args.resourceOwnerId,
        tenantUserId: args.ownerId,
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
      };
      const rows = [
        { sessionId: "a", expiry: aExpiry },
        { sessionId: "z", expiry: zExpiry },
      ];
      for (const row of reverse ? rows.reverse() : rows)
        await db.cacheAffinityNode.create({
          data: {
            ...scope,
            sessionId: row.sessionId,
            rootDigest: material.rootDigest,
            nodeDigest: material.nodes.at(-1)!.digest,
            depth: 3,
            isTip: true,
            expiresAt: new Date(args.now.getTime() + row.expiry),
          },
        });
      for (let run = 0; run < 3; run++)
        expect(await service.resolveAffinitySession(producer, scope, material, args.now)).toBe(
          expected,
        );
    },
  );

  it.each([2, 4])(
    "15.8 bound edit at depth %i discards the previous deeper branch",
    async (depth) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const history = [u("create"), a("reply")];
      const parent = await service.rememberAffinity({ ...args, payload: { input: history } });
      let old = parent!;
      for (let i = 0; i < depth; i++)
        old = (await service.rememberAffinity({
          ...args,
          payload: { input: [u(`old-${i}`)], previous_response_id: "parent" },
          sessionBinding: old,
        }))!;
      const edited = await service.rememberAffinity({
        ...args,
        payload: { input: [u("edited")], previous_response_id: "earlier-parent" },
        sessionBinding: parent!,
      });
      expect(edited!.sessionId).toBe(parent!.sessionId);
      const nodes = await db.cacheAffinityNode.findMany({
        where: { poolId: args.poolId, sessionId: parent!.sessionId },
      });
      expect(nodes.map((node) => node.depth).sort()).toEqual([1, 2, 3]);
      expect(nodes.some((node) => node.nodeDigest === old.tipDigest)).toBe(false);
      const full = service.affinityPrefixDigests({
        ...args,
        payload: { input: [...history, u("edited")] },
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(nodes.map((node) => node.nodeDigest).sort()).toEqual([...full.digests].sort());
    },
  );

  it.each(["userId", "tenantUserId"] as const)(
    "16.4 purge retains queue while only locked nodes remain by %s",
    async (column) => {
      if (!db) return;
      const { purgeDeletedUserHistory, purgeDeletedUsersHistory } = await import(
        "@ws-model-proxy/db/hot-path-sweeps"
      );
      const args = argsFor(await fixture());
      const deletedUserId = column === "userId" ? args.resourceOwnerId : args.ownerId;
      await db.deletedUserPurge.create({
        data: { userId: deletedUserId, deletedAt: new Date("2020-01-01") },
      });
      const node = await db.cacheAffinityNode.create({
        data: {
          userId: args.resourceOwnerId,
          tenantUserId: args.ownerId,
          [column]: deletedUserId,
          poolId: args.poolId,
          executionTargetId: args.target.executionTargetId,
          rootDigest: "r".repeat(43),
          nodeDigest: "n".repeat(43),
          depth: 1,
          sessionId: "locked",
          isTip: true,
          expiresAt: args.now,
        },
      });
      let release!: () => void;
      let ready!: () => void;
      const acquired = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM cache_affinity_node WHERE id = ${node.id} FOR UPDATE`;
          ready();
          await hold;
        },
        { timeout: 15000 },
      );
      await acquired;
      try {
        expect((await purgeDeletedUserHistory(db, deletedUserId, { batch: 1 })).remaining).toBe(
          true,
        );
        await purgeDeletedUsersHistory(db, { now: args.now, batch: 1 });
        expect(
          await db.deletedUserPurge.findUnique({ where: { userId: deletedUserId } }),
        ).not.toBeNull();
      } finally {
        release();
        await locked;
      }
      expect(
        (await purgeDeletedUsersHistory(db, { now: args.now, batch: 1 })).completed,
      ).toBeGreaterThanOrEqual(1);
      expect(await db.deletedUserPurge.findUnique({ where: { userId: deletedUserId } })).toBeNull();
    },
    20000,
  );

  type IndexStats = { indexrelname: string; relname: string; read: bigint; fetch: bigint };
  type TableStats = { relname: string; scans: bigint };
  async function stats() {
    if (!db) throw new Error("database unavailable");
    await db.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
    return {
      indexes: await db.$queryRaw<IndexStats[]>`
        SELECT indexrelname, relname, idx_tup_read AS read, idx_tup_fetch AS fetch
        FROM pg_stat_user_indexes WHERE relname IN ('cache_affinity_node', 'cache_affinity_record')`,
      tables: await db.$queryRaw<TableStats[]>`
        SELECT relname, seq_scan AS scans FROM pg_stat_user_tables
        WHERE relname IN ('cache_affinity_node', 'cache_affinity_record')`,
    };
  }
  async function flushStats() {
    if (!db) throw new Error("database unavailable");
    await producer.$queryRaw`SELECT pg_stat_force_next_flush()::text`;
    // Disconnect flushes *all* producer backends, including the interactive
    // transaction's connection when previous tests grew the pool. No stats lag.
    await producer.$disconnect();
    await db.$queryRaw`SELECT pg_stat_force_next_flush()::text`;
    await db.$disconnect();
  }
  async function measure<T>(operation: () => Promise<T>) {
    await flushStats();
    const before = await stats();
    const start = performance.now();
    const result = await operation();
    const elapsed = performance.now() - start;
    await flushStats();
    const after = await stats();
    const indexes = after.indexes.map((row) => {
      const prev = before.indexes.find((item) => item.indexrelname === row.indexrelname)!;
      return {
        name: row.indexrelname,
        read: Number(row.read - prev.read),
        fetch: Number(row.fetch - prev.fetch),
      };
    });
    for (const table of after.tables) {
      expect(
        Number(table.scans - before.tables.find((row) => row.relname === table.relname)!.scans),
        table.relname,
      ).toBe(0);
    }
    expect(elapsed).toBeLessThan(10000);
    return {
      result,
      indexes,
      read: indexes.reduce((sum, row) => sum + row.read, 0),
      fetch: indexes.reduce((sum, row) => sum + row.fetch, 0),
    };
  }
  const scaleMeasurements: {
    count: number;
    backgroundCount: number;
    probe: { read: number; fetch: number };
    write: { read: number; fetch: number };
  }[] = [];
  async function seedScale(count: number) {
    if (!db) throw new Error("database unavailable");
    const args = argsFor(await fixture());
    const payload = { messages: baseHistory };
    const material = service.affinityPrefixDigests({
      ...args,
      runtimeIdentity: args.target.targetIdentity,
      payload,
    });
    // Avoid the accidental id/heap correlation of a fresh ordered INSERT.
    // Reused heaps need not have that correlation; exercise the expensive
    // point-lookup cost on fresh databases too, without forcing planner flags.
    await db.$executeRaw`INSERT INTO cache_affinity_node
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", depth, "sessionId", "isTip", "expiresAt")
        SELECT 'scale-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId},
          ${material.rootDigest}, ${material.nodes[0]!.digest}, 1, 'scale-' || ${args.poolId} || i, false, ${new Date(args.now.getTime() + 60000)}
        FROM generate_series(1, ${count}) i ORDER BY md5(i::text)`;
    // Real per-session footprints exercise retention too, not an emulated INSERT.
    await db.$executeRaw`INSERT INTO cache_affinity_record
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "expiresAt", "lastUsedAt")
        SELECT 'scale-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId},
          ${args.target.targetIdentity}, ${material.bindingDigest}, md5('footprint-' || i), 'scale-' || ${args.poolId} || i, 0,
          ${new Date(args.now.getTime() + 60000)}, ${args.now}
        FROM generate_series(1, ${count}) i ORDER BY md5(i::text)`;
    return { args, payload, material };
  }
  it.each(
    [10000, 100000].flatMap((count) =>
      [0, 10000].map((backgroundCount) => ({ count, backgroundCount })),
    ),
  )(
    "AC-08/16/61 $count sessions sharing u1: REAL resolution and writer use bounded index work with $backgroundCount other-owner rows",
    async ({ count, backgroundCount }) => {
      if (!db) return;
      const { args, payload, material } = await seedScale(count);
      // Keep the original single-owner cases, and also prove that statistics
      // spanning another owner do not turn the scoped operation into a scan.
      if (backgroundCount) await seedScale(backgroundCount);
      // Equalize visibility/dead tuples as well as statistics: idx_tup_fetch
      // otherwise varies with autovacuum timing rather than population size.
      await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_node");
      await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_record");
      const scope = {
        userId: args.resourceOwnerId,
        tenantUserId: args.ownerId,
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
      };
      const { Prisma } = await import("@ws-model-proxy/db");
      // PostgreSQL may inspect index endpoints while planning. Measure that
      // fixed overhead independently using the SAME production query text
      // (the string resolver still uses the identical probe);
      // retain a total-read bound and compare executor work at both sizes.
      const planning = await measure(() =>
        producer.$queryRaw(
          Prisma.sql`EXPLAIN (FORMAT JSON) ${service.affinityIdentityProbeSql(scope, material, args.now)}`,
        ),
      );
      const probe = await measure(() =>
        service.resolveAffinitySession(producer, scope, material, args.now),
      );
      const execution = { read: probe.read - planning.read, fetch: probe.fetch - planning.fetch };
      expect(execution.read).toBeGreaterThanOrEqual(0);
      expect(execution.fetch).toBeGreaterThanOrEqual(0);
      const write = await measure(() => service.rememberAffinity({ ...args, payload }));
      scaleMeasurements.push({ count, backgroundCount, probe: execution, write });
      process.stdout.write(
        `${JSON.stringify({ count, backgroundCount, probe: { read: probe.read, fetch: probe.fetch }, planning: { read: planning.read, fetch: planning.fetch }, execution, write: { read: write.read, fetch: write.fetch } })}\n`,
      );
      expect(probe.result).toBeNull();
      expect(probe.read).toBeGreaterThan(0);
      // Includes PostgreSQL's fixed planner/index endpoint work, not just the
      // returned rows. The independent population-ratio assertion stays <=2.
      expect(probe.read).toBeLessThanOrEqual(64);
      expect(probe.fetch).toBeLessThanOrEqual(64);
      expect(write.result!.sessionId).not.toMatch(/^scale-/);
      expect(write.read).toBeGreaterThan(0);
      expect(write.read, JSON.stringify(write.indexes)).toBeLessThan(10000);
      expect(write.fetch).toBeLessThan(10000);
      expect(
        await db.cacheAffinityNode.count({ where: { sessionId: write.result!.sessionId } }),
      ).toBe(3);
    },
    180000,
  );
  it("R1 scale cleanup and AC-08/16/61 100k/10k index-work ratio stays constant for REAL probes and writes", async () => {
    if (!db) return;
    const where = { userId: { in: [...fixtureOwnerIds] } };
    expect(await db.cacheAffinityNode.count({ where })).toBe(0);
    expect(await db.cacheAffinityRecord.count({ where })).toBe(0);
    expect(scaleMeasurements.map(({ count, backgroundCount }) => [count, backgroundCount])).toEqual(
      [
        [10000, 0],
        [10000, 10000],
        [100000, 0],
        [100000, 10000],
      ],
    );
    for (const backgroundCount of [0, 10000]) {
      const measurements = scaleMeasurements.filter(
        (row) => row.backgroundCount === backgroundCount,
      );
      for (const kind of ["probe", "write"] as const) {
        for (const counter of ["read", "fetch"] as const) {
          const small = measurements[0]![kind][counter];
          const large = measurements[1]![kind][counter];
          expect(
            large / Math.max(1, small),
            `${kind}.${counter} 100k/10k, other-owner=${backgroundCount}`,
          ).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it.each([10000, 100000])(
    "fenced writer leaves the %i-row expired backlog to bounded batches",
    async (count) => {
      if (!db) return;
      const args = argsFor(await fixture());
      const expired = new Date(args.now.getTime() - 1);
      await db.$executeRaw`INSERT INTO cache_affinity_node
      (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", depth, "sessionId", "isTip", "expiresAt")
      SELECT 'expired-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId},
        md5('root'), md5('digest-' || i), 1, 'expired-' || i, true, ${expired} FROM generate_series(1, ${count}) i`;
      await db.$executeRaw`INSERT INTO cache_affinity_record
      (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "expiresAt")
      SELECT 'expired-' || ${args.poolId} || i, ${args.resourceOwnerId}, ${args.ownerId}, ${args.poolId}, ${args.target.executionTargetId},
        ${args.target.targetIdentity}, md5('binding'), md5('footprint-' || i), 'expired-' || i, 0, ${expired}
      FROM generate_series(1, ${count}) i`;
      await db.$executeRawUnsafe("ANALYZE cache_affinity_node");
      await db.$executeRawUnsafe("ANALYZE cache_affinity_record");
      const start = performance.now();
      await service.rememberAffinity({ ...args, payload: { messages: baseHistory } });
      expect(performance.now() - start).toBeLessThan(10000);
      const where = { poolId: args.poolId, expiresAt: { lte: args.now } };
      expect(await db.cacheAffinityNode.count({ where })).toBe(count - 200);
      expect(await db.cacheAffinityRecord.count({ where })).toBe(count - 200);
    },
    180000,
  );

  it.each(["missing", "expired"])(
    "AC-75 client id and %s binding cannot publish delta-only nodes",
    async (state) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const parent = await service.rememberAffinity({
        ...args,
        payload: { input: "create", conversation: "client" },
      });
      const now = state === "expired" ? new Date(args.now.getTime() + 61000) : args.now;
      const request = {
        ...args,
        now,
        payload: { input: "delta only", previous_response_id: "unbound", conversation: "client" },
      };
      const material = service.affinityPrefixDigests({
        ...request,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(material.nodes).toEqual([]);
      expect(material.identifiable).toBe(false);
      const scope = {
        userId: args.resourceOwnerId,
        tenantUserId: args.ownerId,
        poolId: args.poolId,
        executionTargetId: args.target.executionTargetId,
      };
      expect(await service.resolveAffinitySession(db, scope, material, now)).toBe(
        parent!.sessionId,
      );
      expect(await service.rememberAffinity(request)).toBeNull();
      const deltaOnly = service.affinityPrefixDigests({
        ...request,
        payload: { input: "delta only" },
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(
        await db.cacheAffinityNode.count({
          where: { poolId: args.poolId, nodeDigest: { in: deltaOnly.digests } },
        }),
      ).toBe(0);
      const rows = await db.cacheAffinityRecord.findMany({
        where: { poolId: args.poolId, lastUsedAt: now },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.sessionId === parent!.sessionId)).toBe(true);
    },
  );

  it.each(
    [true, false].flatMap((continuation) => [1, 8, 80].map((turns) => ({ continuation, turns }))),
  )(
    "C2-5 create + $turns bound deltas, stateless continuation=$continuation",
    async ({ continuation, turns }) => {
      if (!db) return;
      const args = { ...argsFor(await fixture()), surface: "openai-responses" };
      const history = continuation ? [u("create"), a("prior reply")] : [u("create")];
      let parent = await service.rememberAffinity({ ...args, payload: { input: history } });
      const sessionId = parent!.sessionId;
      for (let turn = 1; turn <= turns; turn++) {
        const delta = u(`delta ${turn}`);
        history.push(delta);
        parent = await service.rememberAffinity({
          ...args,
          payload: { input: [delta], previous_response_id: `parent-${turn}` },
          sessionBinding: parent!,
          estimatedDeltaTokens: 1,
        });
        expect(parent!.sessionId).toBe(sessionId);
      }
      const material = service.affinityPrefixDigests({
        ...args,
        runtimeIdentity: args.target.targetIdentity,
        payload: { input: history },
      });
      expect(material.nodes.at(-1)!.digest).toBe(parent!.tipDigest);
      expect(
        await db.cacheAffinityNode.count({
          where: { poolId: args.poolId, sessionId, nodeDigest: { in: material.digests } },
        }),
      ).toBe(Math.min(64, turns + 1 + Number(continuation)));
      const ranked = await service.rankAffinityTargets({
        ...args,
        payload: { input: history },
        targets: [args.target],
        scoreSingleTarget: true,
      });
      expect(ranked.matchedSessionIds?.[args.target.executionTargetId]).toBe(
        continuation ? sessionId : undefined,
      );
      const stateless = await service.rememberAffinity({ ...args, payload: { input: history } });
      if (continuation) expect(stateless!.sessionId).toBe(sessionId);
      // Even an identical chain is intentionally fresh if its stateless form
      // is user-only: it cannot distinguish a new starter from truncation.
      else expect(stateless!.sessionId).not.toBe(sessionId);
    },
    60000,
  );
});
