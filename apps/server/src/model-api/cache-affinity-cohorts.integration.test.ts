import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fenceParentDelete } from "@ws-model-proxy/db/capacity-lock-order";
import {
  createPrismaClient,
  createStatementBoundedPrismaClient,
} from "@ws-model-proxy/db/client-factory";
import {
  clearCacheAffinityRecords,
  purgeDeletedUserHistory,
  reclaimClearedAffinity,
} from "@ws-model-proxy/db/hot-path-sweeps";
import { deleteUserDurably } from "@ws-model-proxy/db/parent-deletion";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, expect, it } from "vitest";
import { generateTestHelloIdentity } from "../relay/hello-identity.js";
import { persistRelayRegistration } from "../relay/registration.js";
import { RelaySessionManager } from "../relay/session-manager.js";
import { createUserDeletionSweepClient } from "../user-deletion-sweep.js";
import { affinityResidencySql, rankAffinityTargets, rememberAffinity } from "./cache-affinity.js";
import { registerAffinityObservers } from "./cache-affinity-observers.js";
import {
  captureAffinityTargetGenerations,
  repairAffinityResidencyPage,
} from "./cache-affinity-residency.js";
import { resetKvEvictionForEndpoint } from "./kv-eviction-feedback.js";
import {
  authorizedKvEvictionRows,
  loadWarmSessions,
  warmProtectionSource,
} from "./warm-protection.js";

const url = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !url)
  throw new Error("PostgreSQL integration required");
const integration = url ? it : it.skip;
const db = createFixturePrismaClient(url ?? "postgresql://unused:unused@localhost/unused");
const production = createPrismaClient(url ?? "postgresql://unused:unused@localhost/unused");
const bounded = createStatementBoundedPrismaClient(
  url ?? "postgresql://unused:unused@localhost/unused",
  {
    statementTimeoutMs: 250,
    connectTimeoutMs: 100,
    applicationName: "wsmp-cohort-proof",
    maxConnections: 2,
    minIdleConnections: 0,
    keepAliveInitialDelayMs: 1000,
  },
);
const ownUsers: string[] = [];
const runFile = promisify(execFile);
afterAll(async () => {
  for (const id of ownUsers) {
    if (await db.user.findUnique({ where: { id } })) await deleteUserDurably(production, id);
    await purgeDeletedUserHistory(production, id);
    expect(await db.cacheAffinityRecord.count({ where: { userId: id } })).toBe(0);
    expect(await db.cacheAffinityResidency.count({ where: { userId: id } })).toBe(0);
  }
  process.stdout.write(
    JSON.stringify({ criticCleanup: { users: ownUsers.length, sourceAndProjectionEmpty: true } }) +
      "\n",
  );
  await db.$disconnect();
  await production.$disconnect();
  await bounded.prisma.$disconnect();
}, 180000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { name: "Independent residency reviewer", email: `critic-${suffix}@example.test` },
  });
  ownUsers.push(owner.id);
  const device = await db.cliDevice.create({
    data: { userId: owner.id, slug: `critic-${suffix}` },
  });
  const endpoint = await db.endpoint.create({
    data: {
      userId: owner.id,
      cliDeviceId: device.id,
      slug: `critic-${suffix}`,
      label: "Core fixture",
    },
  });
  const capacity = await db.inferenceCapacity.create({
    data: { userId: owner.id, label: "core", runtimeIdentityKey: suffix, runtimeModel: "core" },
  });
  const model = await db.discoveredModel.create({
    data: {
      userId: owner.id,
      endpointId: endpoint.id,
      upstreamModelId: suffix,
      encodedModelId: suffix,
    },
  });
  const target = await db.executionTarget.update({
    where: { discoveredModelId: model.id },
    data: { inferenceCapacityId: capacity.id },
  });
  const pools = await Promise.all(
    [0, 1].map((i) =>
      db.modelPool.create({
        data: { userId: owner.id, name: "Core", slug: `critic-${suffix}-${i}` },
      }),
    ),
  );
  return { owner, target, capacity, pools };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function finish(f: Fixture) {
  for (let i = 0; i < 30; i++) {
    const b = await db.cacheAffinityResidency.findUniqueOrThrow({
      where: { executionTargetId: f.target.id },
    });
    if (b.complete) return;
    await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity' WHERE "executionTargetId" = ${f.target.id}`;
    await repairAffinityResidencyPage();
  }
  throw new Error("own bucket did not complete");
}

type ObservedSession = {
  cliDeviceId: string;
  connectionGeneration: number;
  /** The registered identity, as an accepted hello records it. */
  identity: { userId: string };
  inventorySlugs: Set<string>;
  socket: { readyState?: number; close(): void; send?(value: unknown): void };
};
const helloKeys = new Map<string, ReturnType<typeof generateTestHelloIdentity>>();

/**
 * What an accepted hello does before `hello.ok`: durable registration advances
 * the connection generation, then this manager registers and renews the
 * physical-cache observer lease for the registered connection.
 */
async function connectObserved(
  manager: RelaySessionManager,
  f: Fixture,
  socket: ObservedSession["socket"],
): Promise<ObservedSession> {
  const model = await db.discoveredModel.findUniqueOrThrow({
    where: { id: f.target.discoveredModelId! },
    include: { Endpoint: { include: { CliDevice: true } } },
  });
  const cliDeviceId = model.Endpoint.cliDeviceId;
  const key = helloKeys.get(cliDeviceId) ?? generateTestHelloIdentity();
  helloKeys.set(cliDeviceId, key);
  const token = await db.cliToken.create({
    data: {
      userId: f.owner.id,
      cliDeviceId,
      name: "observed-connection",
      lookupPrefix: crypto.randomUUID(),
      secretDigest: crypto.randomUUID(),
    },
  });
  const registration = await persistRelayRegistration({
    identity: {
      kind: "cliToken",
      id: token.id,
      userId: f.owner.id,
      cliDeviceId,
      lookupPrefix: token.lookupPrefix,
    },
    cli: { slug: model.Endpoint.CliDevice.slug },
    connection: true,
    identityPublicKey: key.publicKey,
    inventoryConfirmed: true,
    endpointTargeting: true,
    endpoints: [
      {
        slug: model.Endpoint.slug,
        label: "Observed",
        kind: "openai-compatible",
        status: "online",
        defaultCapabilities: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true },
        },
        models: [{ upstreamModelId: model.upstreamModelId, capabilityOverrideMode: "inherit" }],
      },
    ],
  });
  const session: ObservedSession = {
    cliDeviceId,
    connectionGeneration: registration.connectionGeneration,
    identity: { userId: f.owner.id },
    inventorySlugs: new Set([model.Endpoint.slug]),
    socket,
  };
  const internals = manager as unknown as {
    affinityObserverManagerId: string;
    sessionsByCliDeviceId: Map<string, ObservedSession>;
    startAffinityObserverMaintenance(): void;
  };
  internals.sessionsByCliDeviceId.set(cliDeviceId, session);
  await registerAffinityObservers({
    cliDeviceId,
    slugs: [model.Endpoint.slug],
    connectionGeneration: registration.connectionGeneration,
    managerId: internals.affinityObserverManagerId,
  });
  internals.startAffinityObserverMaintenance();
  return session;
}

integration(
  "active friend cohorts record and rank privately while physical occupancy spans three pools",
  async () => {
    const consumer = await fixture();
    const friend = await fixture();
    const target = {
      poolMemberId: "unused",
      executionTargetId: friend.target.id,
      targetIdentity: "cohort",
      capacityId: friend.capacity.id,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    };
    const policy = {
      enabled: true,
      ttlSeconds: 600,
      maxRecords: 100,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
    };
    const grants: string[] = [];
    for (const pool of consumer.pools) {
      const grant = await db.inferenceContribution.create({
        data: {
          contributorUserId: friend.owner.id,
          poolOwnerUserId: consumer.owner.id,
          poolId: pool.id,
          discoveredModelId: friend.target.discoveredModelId!,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await db.inferenceContribution.update({
        where: { id: grant.id },
        data: { state: "ACTIVE", acceptedAt: new Date() },
      });
      const member = await db.poolMember.create({
        data: {
          poolId: pool.id,
          discoveredModelId: friend.target.discoveredModelId!,
          executionTargetId: friend.target.id,
          inferenceContributionId: grant.id,
        },
      });
      if (pool.id === consumer.pools[0]!.id) target.poolMemberId = member.id;
      grants.push(grant.id);
    }
    const args = {
      ownerId: consumer.owner.id,
      resourceOwnerId: consumer.owner.id,
      poolId: consumer.pools[0]!.id,
      securityScope: "cohort-private",
      policy,
      surface: "openai-chat",
      payload: {
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "followup" },
        ],
      },
      target,
      estimatedTokens: 100,
    };
    const first = await rememberAffinity(args);
    expect(first).not.toBeNull();
    const second = await rememberAffinity({ ...args, poolId: consumer.pools[1]!.id });
    const own = await rememberAffinity({
      ...args,
      ownerId: friend.owner.id,
      resourceOwnerId: friend.owner.id,
      poolId: friend.pools[0]!.id,
    });
    expect(second).not.toBeNull();
    expect(own).not.toBeNull();
    expect(new Set([first!.bindingDigest, second!.bindingDigest, own!.bindingDigest]).size).toBe(3);
    expect(
      await db.cacheAffinityRecord.count({
        where: { poolId: consumer.pools[0]!.id, executionTargetId: friend.target.id },
      }),
    ).toBeGreaterThan(0);
    const rank = (patch: Partial<typeof args> = {}) =>
      rankAffinityTargets({ ...args, ...patch, targets: [target], scoreSingleTarget: true });
    expect((await rank()).scores[friend.target.id]).toBeGreaterThan(0);
    for (const patch of [
      { ownerId: friend.owner.id },
      { securityScope: "different-scope" },
      { poolId: consumer.pools[1]!.id, securityScope: "different-scope" },
      { accessGrantId: "foreign-grant" },
    ]) {
      const result = await rank(patch);
      expect(result.scores[friend.target.id]).toBe(0);
      expect(result.matchedSessionIds?.[friend.target.id]).toBeUndefined();
    }
    const footprints = await db.cacheAffinityRecord.findMany({
      where: { executionTargetId: friend.target.id, prefixDigest: null },
    });
    expect(footprints).toHaveLength(3);
    expect(footprints.every((row) => row.sharedWithSessionId === null)).toBe(true);
    await finish(friend);
    const resident = await production.$queryRaw<Array<{ sessionId: string }>>(
      affinityResidencySql(
        consumer.owner.id,
        [friend.capacity.id],
        new Date(),
        undefined,
        consumer.pools[0]!.id,
      ),
    );
    expect(new Set(resident.map((row) => row.sessionId)).size).toBe(3);
    expect(
      (
        await db.cacheAffinityResidency.findUniqueOrThrow({
          where: { executionTargetId: friend.target.id },
        })
      ).userId,
    ).toBe(friend.owner.id);
    const warm = await loadWarmSessions({
      ownerId: consumer.owner.id,
      capacityIds: [friend.capacity.id],
      policy: { windowSeconds: 600, minTokens: 1 },
    });
    await db.capacityKvEviction.create({
      data: {
        capacityId: friend.capacity.id,
        userId: friend.owner.id,
        cutFraction: 0.5,
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        sessionIds: ["friend-feedback"],
      },
    });
    const feedbackArgs = {
      ownerId: consumer.owner.id,
      capacityIds: [friend.capacity.id],
      policy: {
        enabled: true,
        windowSeconds: 600,
        minTokens: 1,
        share: "FIRST_COME" as const,
        fixedPercent: null,
      },
    };
    expect(
      (await warmProtectionSource.load(feedbackArgs)).kvEvictionByCapacity.has(friend.capacity.id),
    ).toBe(true);
    const feedbackRows = await db.capacityKvEviction.findMany({
      where: { capacityId: friend.capacity.id },
    });
    expect(
      await authorizedKvEvictionRows(
        feedbackRows,
        consumer.owner.id,
        new Date(),
        production,
        friend.pools[0]!.id,
      ),
    ).toEqual([]);
    expect(
      await authorizedKvEvictionRows(
        feedbackRows,
        consumer.owner.id,
        new Date(Date.now() + 7200000),
        production,
        consumer.pools[0]!.id,
      ),
    ).toEqual([]);
    expect(warm.get(friend.capacity.id)).toHaveLength(3);
    const physicalModel = await db.discoveredModel.findUniqueOrThrow({
      where: { id: friend.target.discoveredModelId! },
      include: { Endpoint: true },
    });
    await resetKvEvictionForEndpoint(
      physicalModel.Endpoint.cliDeviceId,
      physicalModel.Endpoint.slug,
    );
    expect(
      await production.$queryRaw(
        affinityResidencySql(consumer.owner.id, [friend.capacity.id], new Date()),
      ),
    ).toHaveLength(0);
    expect((await rank()).scores[friend.target.id]).toBe(0);
    expect(
      (
        await loadWarmSessions({
          ownerId: consumer.owner.id,
          capacityIds: [friend.capacity.id],
          policy: { windowSeconds: 600, minTokens: 1 },
        })
      ).size,
    ).toBe(0);
    await expect(rememberAffinity(args)).rejects.toThrow(/generation has reset/);
    const [freshTarget] = await captureAffinityTargetGenerations([target]);
    await rememberAffinity({ ...args, target: freshTarget! });
    await rememberAffinity({ ...args, target: freshTarget!, poolId: consumer.pools[1]!.id });
    await rememberAffinity({
      ...args,
      target: freshTarget!,
      ownerId: friend.owner.id,
      resourceOwnerId: friend.owner.id,
      poolId: friend.pools[0]!.id,
    });
    expect(
      await production.$queryRaw(
        affinityResidencySql(consumer.owner.id, [friend.capacity.id], new Date()),
      ),
    ).toHaveLength(3);
    await clearCacheAffinityRecords(production, {
      ownerUserId: consumer.owner.id,
      poolId: consumer.pools[0]!.id,
    });
    expect((await rank()).scores[friend.target.id]).toBe(0);
    expect(
      (await rank({ poolId: consumer.pools[1]!.id })).scores[friend.target.id],
    ).toBeGreaterThan(0);
    const afterClear = await production.$queryRaw<Array<{ sessionId: string }>>(
      affinityResidencySql(consumer.owner.id, [friend.capacity.id], new Date()),
    );
    expect(new Set(afterClear.map((row) => row.sessionId)).size).toBe(2);
    await db.inferenceContribution.update({
      where: { id: grants[0]! },
      data: { state: "REVOKED", revokedAt: new Date() },
    });
    expect(
      await authorizedKvEvictionRows(
        feedbackRows,
        consumer.owner.id,
        new Date(),
        production,
        consumer.pools[0]!.id,
      ),
    ).toEqual([]);
    expect(
      await authorizedKvEvictionRows(
        feedbackRows,
        consumer.owner.id,
        new Date(),
        production,
        consumer.pools[1]!.id,
      ),
    ).toHaveLength(1);
    // The pre-clear capture is fenced by the pool scope. A current capture (as
    // production takes, with its pool id) reaches the contribution guard.
    await expect(rememberAffinity({ ...args, target: freshTarget! })).rejects.toThrow(
      /generation has reset/,
    );
    const [clearedTarget] = await captureAffinityTargetGenerations([target], consumer.pools[0]!.id);
    expect(clearedTarget!.cacheGeneration).toContain(":pool:");
    await expect(rememberAffinity({ ...args, target: clearedTarget! })).rejects.toThrow(
      /active pool contribution/,
    );
    await expect(rememberAffinity({ ...args, poolId: friend.pools[1]!.id })).resolves.toBeNull();
    await expect(
      production.$executeRaw`INSERT INTO cache_affinity_node (id, "userId", "tenantUserId", "poolId", "executionTargetId", "cacheGeneration", "rootDigest", "nodeDigest", depth, "sessionId", "isTip", "expiresAt") VALUES (${crypto.randomUUID()}, ${consumer.owner.id}, ${consumer.owner.id}, ${consumer.pools[0]!.id}, ${friend.target.id}, ${clearedTarget!.cacheGeneration}, repeat('a',32), repeat('b',32), 1, 'unauthorized', true, '2099-01-01')`,
    ).rejects.toThrow(/active pool contribution/);
    expect(await deleteUserDurably(production, consumer.owner.id)).toBe("deleted");
    expect((await purgeDeletedUserHistory(production, consumer.owner.id)).remaining).toBe(false);
    expect(await db.cacheAffinityRecord.count({ where: { poolId: consumer.pools[1]!.id } })).toBe(
      0,
    );
    expect(
      await db.cacheAffinityRecord.count({ where: { poolId: friend.pools[0]!.id } }),
    ).toBeGreaterThan(0);
    // The purge marks the shared physical bucket unknown without reading its
    // payload; bounded repair restores the surviving friend's own cohort.
    expect(
      await production.$queryRaw(
        affinityResidencySql(friend.owner.id, [friend.capacity.id], new Date()),
      ),
    ).toEqual([]);
    await finish(friend);
    expect(
      await production.$queryRaw(
        affinityResidencySql(friend.owner.id, [friend.capacity.id], new Date()),
      ),
    ).toHaveLength(1);
  },
  30000,
);

integration(
  "maximum normal expiry fanout and eight saturated buckets stay within owned budgets",
  async () => {
    const f = await fixture();
    const model = await db.discoveredModel.findUniqueOrThrow({
      where: { id: f.target.discoveredModelId! },
    });
    const models = Array.from({ length: 200 }, (_, i) => ({
      id: `cohort-volume-${crypto.randomUUID()}`,
      userId: f.owner.id,
      endpointId: model.endpointId,
      upstreamModelId: `volume-${i}`,
      encodedModelId: `volume-${i}`,
    }));
    await db.discoveredModel.createMany({ data: models });
    const extras = await db.executionTarget.findMany({
      where: { discoveredModelId: { in: models.map((m) => m.id) } },
      orderBy: { id: "asc" },
    });
    await production.$executeRaw`INSERT INTO cache_affinity_record
    (id, "createdAt", "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
    SELECT target_id || '-expired', '2019-01-01', ${f.owner.id}, ${f.owner.id}, ${f.pools[0]!.id}, target_id, 'volume', md5(target_id), md5(target_id), target_id, 0, 1, '2020-01-01'
    FROM unnest(${extras.map((t) => t.id)}::text[]) AS target_id`;
    for (const target of extras) {
      await finish({ ...f, target });
      await production.$executeRaw`INSERT INTO cache_affinity_record
      (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
      SELECT ${target.id} || '-' || i, ${f.owner.id}, ${f.owner.id}, ${f.pools[1]!.id}, ${target.id}, 'volume', md5(i::text), md5(i::text), ${target.id} || '-session-' || i, 0, 100, '2099-01-01'
      FROM generate_series(1, 2000) i`;
    }
    await production.$executeRaw`INSERT INTO cache_affinity_record
    (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
    SELECT ${f.target.id} || '-retention-' || i, ${f.owner.id}, ${f.owner.id}, ${f.pools[0]!.id}, ${f.target.id}, 'volume', md5(i::text), md5(i::text), 'retention-' || i, 0, 100, '2099-01-01' FROM generate_series(1, 100) i`;
    await finish(f);
    const [beforeVolume] = await production.$queryRaw<
      Array<{ revisions: bigint; entries: bigint; bytes: bigint }>
    >`SELECT sum(revision)::bigint AS revisions, sum(jsonb_array_length(entries))::bigint AS entries, sum(octet_length(entries::text))::bigint AS bytes FROM cache_affinity_residency WHERE "userId" = ${f.owner.id}`;
    expect(Number(beforeVolume!.entries)).toBe(400100);
    const started = Date.now();
    const remembered = await rememberAffinity({
      ownerId: f.owner.id,
      resourceOwnerId: f.owner.id,
      poolId: f.pools[0]!.id,
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
      payload: {
        conversation_id: "volume",
        messages: [{ role: "user", content: "new completion" }],
      },
      target: {
        executionTargetId: f.target.id,
        poolMemberId: "volume",
        capacityId: f.capacity.id,
        targetIdentity: "volume",
        hardConcurrencyLimit: null,
        healthPenalty: 0,
        publicEgressPenalty: 0,
        costPenalty: 0,
      },
      estimatedTokens: 100,
    });
    const completionMs = Date.now() - started;
    expect(remembered).not.toBeNull();
    expect(completionMs).toBeLessThan(2500);
    expect(
      await db.cacheAffinityRecord.count({
        where: { userId: f.owner.id, expiresAt: { lt: new Date() } },
      }),
    ).toBe(192);
    const [afterVolume] = await production.$queryRaw<
      Array<{ revisions: bigint }>
    >`SELECT sum(revision)::bigint AS revisions FROM cache_affinity_residency WHERE "userId" = ${f.owner.id}`;
    expect(Number(afterVolume!.revisions - beforeVolume!.revisions)).toBe(11);
    const capacityIds: string[] = [];
    for (const [i, target] of extras.slice(0, 8).entries()) {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: f.owner.id,
          label: `saturated-${i}`,
          runtimeIdentityKey: crypto.randomUUID(),
          runtimeModel: "volume",
        },
      });
      await db.executionTarget.update({
        where: { id: target.id },
        data: { inferenceCapacityId: capacity.id },
      });
      capacityIds.push(capacity.id);
      await finish({ ...f, target });
    }
    const readStarted = Date.now();
    const rows = await bounded.prisma.$queryRaw<Array<{ complete: boolean; rows: unknown[] }>>(
      affinityResidencySql(f.owner.id, capacityIds, new Date(), undefined, f.pools[1]!.id, true),
    );
    const readerMs = Date.now() - readStarted;
    expect(rows[0]?.complete).toBe(true);
    expect(rows[0]?.rows).toHaveLength(16000);
    expect(readerMs).toBeLessThan(500);
    process.stdout.write(
      JSON.stringify({
        cohortVolume: {
          expiredTargets: 200,
          saturatedBuckets: 200,
          sourceFootprints: 400300,
          bucketUpdates: Number(afterVolume!.revisions - beforeVolume!.revisions),
          retainedLogicalBytes: Number(beforeVolume!.bytes),
          completionMs,
          readTargets: 8,
          readEntries: rows[0]!.rows.length,
          readerMs,
          readerStatementMs: 250,
          logicalJsonBytes: Buffer.byteLength(JSON.stringify(rows)),
        },
      }) + "\n",
    );
    // The actual parent-deletion client has a 3s statement budget. Sparse
    // footprints must make progress without rewriting another tenant's400000 entries.
    const deletion = createUserDeletionSweepClient(url!);
    try {
      for (const mode of ["drain", "purge"] as const) {
        const tenant = await db.user.create({
          data: {
            name: "Sparse cache tenant",
            email: `cache-drain-${crypto.randomUUID()}@example.test`,
          },
        });
        ownUsers.push(tenant.id);
        await production.$executeRaw`INSERT INTO cache_affinity_record
          (id,"userId","tenantUserId","poolId","executionTargetId","targetIdentity","bindingDigest","conversationDigest","sessionId","prefixDepth","estimatedTokens","expiresAt")
          SELECT target_id || '-sparse-' || ${mode} || '-' || i, ${f.owner.id}, ${tenant.id}, ${f.pools[0]!.id},
            target_id, 'sparse', md5(i::text), md5(i::text), 'sparse-' || i, 0, 1, '2098-01-01'
          FROM unnest(${extras.map((t) => t.id)}::text[]) target_id CROSS JOIN generate_series(1,5) i`;
        const started = performance.now();
        if (mode === "drain")
          expect(await deleteUserDurably(deletion.prisma, tenant.id)).toBe("deleted");
        else expect((await purgeDeletedUserHistory(production, tenant.id)).remaining).toBe(false);
        expect(await db.cacheAffinityRecord.count({ where: { tenantUserId: tenant.id } })).toBe(0);
        expect(await db.cacheAffinityRecord.count({ where: { poolId: f.pools[1]!.id } })).toBe(
          400000,
        );
        process.stdout.write(
          JSON.stringify({
            cacheLifecycleDrain: {
              mode,
              selectedRows: 1000,
              sparseBuckets: 200,
              clientStatementTimeoutMs: mode === "drain" ? 3000 : "shared",
              milliseconds: performance.now() - started,
              remaining: 0,
              otherRows: 400000,
            },
          }) + "\n",
        );
      }
    } finally {
      await deletion.prisma.$disconnect();
    }
    const clearStarted = performance.now();
    expect(
      await clearCacheAffinityRecords(production, {
        ownerUserId: f.owner.id,
        poolId: f.pools[1]!.id,
      }),
    ).toEqual({ cleared: true, reclamation: "pending" });
    expect(performance.now() - clearStarted).toBeLessThan(2500);
    const logicalClearMs = performance.now() - clearStarted;
    expect(await db.cacheAffinityRecord.count({ where: { poolId: f.pools[1]!.id } })).toBe(400000);
    const sourceBefore = await db.cacheAffinityRecord.count({ where: { poolId: f.pools[0]!.id } });
    let reclaimed = 0;
    let batches = 0;
    let worstBatchMs = 0;
    while (batches++ < 2000) {
      const batchStarted = performance.now();
      const removed = await reclaimClearedAffinity(production, {
        ownerUserId: f.owner.id,
        poolId: f.pools[1]!.id,
      });
      worstBatchMs = Math.max(worstBatchMs, performance.now() - batchStarted);
      if (removed === 0) break;
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThanOrEqual(512);
      reclaimed += removed;
    }
    expect(reclaimed).toBe(400000);
    expect(await db.cacheAffinityRecord.count({ where: { poolId: f.pools[1]!.id } })).toBe(0);
    expect(await db.cacheAffinityRecord.count({ where: { poolId: f.pools[0]!.id } })).toBe(
      sourceBefore,
    );
    process.stdout.write(
      JSON.stringify({
        cacheLifecycleClear: {
          logicalClearMs,
          physicalRowsImmediatelyAfterClear: 400000,
          reclaimed,
          batches,
          worstBatchMs,
          milliseconds: performance.now() - clearStarted,
        },
      }) + "\n",
    );
  },
  600000,
);

integration(
  "installer replay preserves in-flight repair and a separate OS process resumes its durable page",
  async () => {
    // The previous test churns 400k source/projection rows. The resulting
    // cost-throttled autovacuum holds SHARE UPDATE EXCLUSIVE for longer than
    // the installer's bounded NOWAIT retry (autovacuum is only cancelled for a
    // waiting locker). Reclaim that churn in the foreground first, so this
    // test measures replay, not background-maintenance timing. A manual
    // VACUUM waits for (and thereby cancels) a running autovacuum.
    for (const table of [
      "cache_affinity_record",
      "cache_affinity_node",
      "cache_affinity_residency",
    ])
      await db.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`);
    const f = await fixture();
    await production.$executeRaw`INSERT INTO cache_affinity_record
    (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
    SELECT ${f.target.id} || '-' || lpad(i::text, 6, '0'), ${f.owner.id}, ${f.owner.id}, ${f.pools[0]!.id}, ${f.target.id}, 'restart', md5(i::text), md5(i::text), i::text, 0, 10, '2099-01-01' FROM generate_series(1, 1025) i`;
    await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity' WHERE "executionTargetId" = ${f.target.id}`;
    await repairAffinityResidencyPage();
    const before = await db.cacheAffinityResidency.findUniqueOrThrow({
      where: { executionTargetId: f.target.id },
    });
    expect(before.repairCursor).not.toBeNull();
    expect(before.complete).toBe(false);
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    for (let i = 0; i < 2; i++)
      await runFile(process.execPath, ["packages/db/scripts/apply-schema-hardening.mjs"], {
        cwd: root,
        env: { ...process.env, SCHEMA_HARDENING_FORCE: "1" },
        timeout: 30000,
      });
    expect(
      await db.cacheAffinityResidency.findUniqueOrThrow({
        where: { executionTargetId: f.target.id },
      }),
    ).toEqual(before);
    expect(await db.cacheAffinityRecord.count({ where: { executionTargetId: f.target.id } })).toBe(
      1025,
    );
    await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity' WHERE "executionTargetId" = ${f.target.id}`;
    await runFile(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "const { repairAffinityResidencyPage } = await import('./src/model-api/cache-affinity-residency.ts'); await repairAffinityResidencyPage(); process.exit(0);",
      ],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, timeout: 15000 },
    );
    const resumed = await db.cacheAffinityResidency.findUniqueOrThrow({
      where: { executionTargetId: f.target.id },
    });
    expect(resumed.repairCursor).not.toBe(before.repairCursor);
    expect(resumed.repairEntries).toHaveLength(512);
    await finish(f);
    expect(
      await production.$queryRaw(affinityResidencySql(f.owner.id, [f.capacity.id], new Date())),
    ).toHaveLength(1025);
    process.stdout.write(
      JSON.stringify({
        cohortRestart: {
          installerReplays: 2,
          retainedRows: 1025,
          resumedEntries: 512,
          quietRepairComplete: true,
        },
      }) + "\n",
    );
  },
  90000,
);

integration(
  "competing first bucket insertion cancels cleanly while graph deletion remains independent",
  async () => {
    const f = await fixture();
    let release!: () => void;
    let signal!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holder = production.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO cache_affinity_residency ("executionTargetId", "userId") VALUES (${f.target.id}, ${f.owner.id})`;
      signal();
      await released;
    });
    await held;
    const started = Date.now();
    const source = bounded.prisma.$executeRaw`INSERT INTO cache_affinity_record
    (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
    VALUES (${f.target.id + "-first"}, ${f.owner.id}, ${f.owner.id}, ${f.pools[0]!.id}, ${f.target.id}, 'first', repeat('a',32), repeat('b',32), 'first', 0, 100, '2099-01-01')`.then(
      () => ({ ok: true, error: "" }),
      (error) => ({ ok: false, error: String(error) }),
    );
    try {
      let observedWait = false;
      for (let probe = 0; probe < 20; probe++) {
        const [state] = await production.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'wsmp-cohort-proof' AND wait_event_type = 'Lock') AS waiting`;
        if (state?.waiting) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(observedWait).toBe(true);
      await production.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await fenceParentDelete(tx, { userId: f.owner.id, executionTargetIds: [f.target.id] });
        await tx.executionTarget.delete({ where: { id: f.target.id } });
      });
      const result = await source;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/statement timeout/);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(
        await production.cacheAffinityRecord.count({ where: { executionTargetId: f.target.id } }),
      ).toBe(0);
      expect(await bounded.prisma.$queryRaw`SELECT 1 AS reusable`).toEqual([{ reusable: 1 }]);
    } finally {
      release();
      await holder;
    }
  },
);

integration(
  "physical reset fences all cohorts, late completion and repair while fresh completion restores warmth",
  async () => {
    const f = await fixture();
    const model = await db.discoveredModel.findUniqueOrThrow({
      where: { id: f.target.discoveredModelId! },
      include: { Endpoint: true },
    });
    const manager = new RelaySessionManager();
    try {
      const session = await connectObserved(manager, f, {
        close() {
          throw new Error("durable intent must survive optional bucket timeout");
        },
      });
      const target = {
        poolMemberId: "unused",
        executionTargetId: f.target.id,
        targetIdentity: "stable-runtime",
        capacityId: f.capacity.id,
        hardConcurrencyLimit: null,
        healthPenalty: 0,
        publicEgressPenalty: 0,
        costPenalty: 0,
        cacheGeneration: "",
      };
      const args = {
        ownerId: f.owner.id,
        resourceOwnerId: f.owner.id,
        poolId: f.pools[0]!.id,
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
        payload: {
          messages: [
            { role: "user", content: "question" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "followup" },
          ],
        },
        target,
        estimatedTokens: 100,
      };
      // A registered connection is part of the physical cache generation.
      target.cacheGeneration = (
        await captureAffinityTargetGenerations([target])
      )[0]!.cacheGeneration;
      expect(target.cacheGeneration).toContain(":connection:");
      await rememberAffinity(args);
      await finish(f);
      const before = await rankAffinityTargets({
        ...args,
        targets: [target],
        scoreSingleTarget: true,
      });
      const producer = manager as unknown as {
        seedCounterEpochs(id: string): Promise<void>;
        noteKvEvictionResetSignal(
          session: ObservedSession,
          load: { endpointSlug: string; counterEpoch: number; prefixCacheReset?: boolean },
          now: Date,
        ): Promise<void>;
      };
      await db.endpoint.update({ where: { id: model.Endpoint.id }, data: { loadCounterEpoch: 1 } });
      await producer.seedCounterEpochs(model.Endpoint.cliDeviceId);
      let releaseReset!: () => void;
      let heldReset!: () => void;
      const resetHeld = new Promise<void>((resolve) => {
        heldReset = resolve;
      });
      const resetRelease = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const resetBlocker = production.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "executionTargetId" FROM cache_affinity_residency
        WHERE "executionTargetId" = ${f.target.id} FOR UPDATE`;
        heldReset();
        await resetRelease;
      });
      await resetHeld;
      try {
        await producer.noteKvEvictionResetSignal(
          session,
          { endpointSlug: model.Endpoint.slug, counterEpoch: 2 },
          new Date(),
        );
        expect(
          (await db.endpoint.findUniqueOrThrow({ where: { id: model.Endpoint.id } }))
            .loadCounterEpoch,
        ).toBe(2);
        const stillLocked = await rankAffinityTargets({
          ...args,
          targets: [target],
          scoreSingleTarget: true,
        });
        expect(stillLocked.scores[f.target.id]).toBe(0);
        const child = await runFile(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `const { rankAffinityTargets } = await import('./src/model-api/cache-affinity.ts'); const result = await rankAffinityTargets(${JSON.stringify({ ...args, targets: [target], scoreSingleTarget: true })}); process.stdout.write(JSON.stringify(result.scores)); process.exit(0);`,
          ],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env: process.env,
            timeout: 15000,
          },
        );
        expect(JSON.parse(child.stdout)[f.target.id]).toBe(0);
        expect(
          await loadWarmSessions({
            ownerId: f.owner.id,
            capacityIds: [f.capacity.id],
            policy: { windowSeconds: 600, minTokens: 1 },
          }),
        ).toEqual(new Map());
      } finally {
        releaseReset();
        await resetBlocker;
      }
      const [fresh] = await captureAffinityTargetGenerations([target]);
      const after = await rankAffinityTargets({
        ...args,
        targets: [fresh!],
        scoreSingleTarget: true,
      });
      expect(before.scores[f.target.id]).toBeGreaterThan(0);
      expect(after.scores[f.target.id]).toBe(0);
      expect(fresh!.cacheGeneration).not.toBe("");
      let unlock!: () => void;
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const lockRelease = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const blocker = production.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE cache_affinity_residency IN ACCESS EXCLUSIVE MODE`;
        locked();
        await lockRelease;
      });
      await lockHeld;
      try {
        const generationUnavailable = await rankAffinityTargets({
          ...args,
          targets: [{ ...target, costPenalty: 17 }],
          scoreSingleTarget: true,
        });
        expect(generationUnavailable.scores[f.target.id]).toBe(-17);
        expect(generationUnavailable.matchedSessionIds?.[f.target.id]).toBeUndefined();
      } finally {
        unlock();
        await blocker;
      }
      expect(
        await production.$queryRaw(affinityResidencySql(f.owner.id, [f.capacity.id], new Date())),
      ).toHaveLength(0);
      await expect(rememberAffinity(args)).rejects.toThrow(/generation has reset/);
      await db.cacheAffinityResidency.update({
        where: { executionTargetId: f.target.id },
        data: { complete: false },
      });
      await finish(f);
      expect(
        await production.$queryRaw(affinityResidencySql(f.owner.id, [f.capacity.id], new Date())),
      ).toHaveLength(0);
      const binding = await rememberAffinity({ ...args, target: fresh! });
      expect(binding).not.toBeNull();
      const restored = await rankAffinityTargets({
        ...args,
        targets: [fresh!],
        scoreSingleTarget: true,
      });
      expect(restored.scores[f.target.id]).toBeGreaterThan(0);
      expect(
        await production.$queryRaw(affinityResidencySql(f.owner.id, [f.capacity.id], new Date())),
      ).toHaveLength(1);
      process.stdout.write(
        JSON.stringify({
          physicalResetCandidate: {
            before: before.scores,
            after: after.scores,
            restored: restored.scores,
          },
        }) + "\n",
      );
    } finally {
      // Renewal stays owned until the end: lease expiry alone must not decide warmth.
      manager.dispose();
    }
  },
);

integration(
  "pool clear fences old completions and repair while another pool and fresh requests survive",
  async () => {
    const f = await fixture();
    const target = {
      executionTargetId: f.target.id,
      poolMemberId: "scope",
      capacityId: f.capacity.id,
      targetIdentity: "scope-runtime",
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    };
    const args = {
      ownerId: f.owner.id,
      resourceOwnerId: f.owner.id,
      poolId: f.pools[0]!.id,
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
      payload: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "followup" },
        ],
      },
      target,
      estimatedTokens: 100,
    };
    await rememberAffinity(args);
    await rememberAffinity({ ...args, poolId: f.pools[1]!.id });
    await finish(f);
    const rank = (poolId: string) =>
      rankAffinityTargets({ ...args, poolId, targets: [target], scoreSingleTarget: true });
    expect((await rank(args.poolId)).scores[f.target.id]).toBeGreaterThan(0);
    const oldCount = await db.cacheAffinityRecord.count({ where: { poolId: args.poolId } });
    const oldNodes = await db.cacheAffinityNode.count({ where: { poolId: args.poolId } });
    expect(
      await clearCacheAffinityRecords(production, { ownerUserId: f.owner.id, poolId: args.poolId }),
    ).toEqual({ cleared: true, reclamation: "pending" });
    expect(await db.cacheAffinityRecord.count({ where: { poolId: args.poolId } })).toBe(oldCount);
    expect((await rank(args.poolId)).scores[f.target.id]).toBe(0);
    expect((await rank(f.pools[1]!.id)).scores[f.target.id]).toBeGreaterThan(0);
    await expect(rememberAffinity(args)).rejects.toThrow(/generation has reset/);
    await db.$executeRaw`UPDATE cache_affinity_residency SET complete = false, "repairAfter" = '-infinity',
    "repairEntries" = '[]', "repairCursor" = NULL WHERE "executionTargetId" = ${f.target.id}`;
    await finish(f);
    expect((await rank(args.poolId)).scores[f.target.id]).toBe(0);
    const [fresh] = await captureAffinityTargetGenerations([target], args.poolId);
    await rememberAffinity({ ...args, target: fresh! });
    expect((await rank(args.poolId)).scores[f.target.id]).toBeGreaterThan(0);
    const child = await runFile(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {default:db}=await import('@ws-model-proxy/db'); const {reclaimClearedAffinity}=await import('@ws-model-proxy/db/hot-path-sweeps'); const removed=await reclaimClearedAffinity(db,${JSON.stringify({ ownerUserId: f.owner.id, poolId: args.poolId })}); console.log(JSON.stringify({removed})); await db.$disconnect();`,
      ],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, timeout: 15000 },
    );
    expect(JSON.parse(child.stdout.trim()).removed).toBe(oldCount + oldNodes);
    expect((await rank(args.poolId)).scores[f.target.id]).toBeGreaterThan(0);
    expect((await rank(f.pools[1]!.id)).scores[f.target.id]).toBeGreaterThan(0);
    expect(
      (await db.cacheAffinityScope.findUniqueOrThrow({ where: { poolId: args.poolId } }))
        .reclaimPending,
    ).toBe(false);
  },
);

integration(
  "observed authority and epoch failures recover without redelivery and preserve other warmth and serving",
  async () => {
    const f = await fixture();
    const other = await fixture();
    const model = await db.discoveredModel.findUniqueOrThrow({
      where: { id: f.target.discoveredModelId! },
      include: { Endpoint: { include: { CliDevice: true } } },
    });
    const target = (g: Fixture) => ({
      poolMemberId: "unused",
      executionTargetId: g.target.id,
      capacityId: g.capacity.id,
      targetIdentity: "failure-lifecycle",
      cacheGeneration: "",
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    });
    const args = (g: Fixture) => ({
      ownerId: g.owner.id,
      resourceOwnerId: g.owner.id,
      poolId: g.pools[0]!.id,
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
      payload: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "next" },
        ],
      },
      target: target(g),
      estimatedTokens: 100,
    });
    const manager = new RelaySessionManager();
    let closes = 0;
    const sent: unknown[] = [];
    const socket = {
      readyState: 1,
      close() {
        closes++;
      },
      send(value: unknown) {
        sent.push(value);
      },
    };
    const producer = manager as unknown as {
      seedCounterEpochs(id: string): Promise<void>;
      noteKvEvictionResetSignal(
        s: ObservedSession,
        load: { endpointSlug: string; counterEpoch: number },
        now: Date,
      ): Promise<void>;
      pendingAffinityResets: Map<string, unknown>;
    };
    const pendingResets = producer.pendingAffinityResets;
    let successor: RelaySessionManager | undefined;
    try {
      const session = await connectObserved(manager, f, socket);
      const [registered] = await captureAffinityTargetGenerations([target(f)]);
      expect(registered!.cacheGeneration).toContain(":connection:");
      await rememberAffinity({ ...args(f), target: registered! });
      await rememberAffinity(args(other));
      await db.endpoint.update({ where: { id: model.Endpoint.id }, data: { loadCounterEpoch: 1 } });
      await producer.seedCounterEpochs(session.cliDeviceId);
      try {
        for (const [table, id, epoch] of [
          ["inference_capacity", f.capacity.id, 2],
          ["endpoint", model.Endpoint.id, 3],
        ] as const) {
          let release!: () => void;
          let held!: () => void;
          const lockHeld = new Promise<void>((resolve) => {
            held = resolve;
          });
          const lockRelease = new Promise<void>((resolve) => {
            release = resolve;
          });
          const blocker = production.$transaction(async (tx) => {
            if (table === "inference_capacity")
              await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${id} FOR UPDATE`;
            else await tx.$queryRaw`SELECT id FROM endpoint WHERE id = ${id} FOR UPDATE`;
            held();
            await lockRelease;
          });
          await lockHeld;
          try {
            const start = performance.now();
            await producer.noteKvEvictionResetSignal(
              session,
              { endpointSlug: model.Endpoint.slug, counterEpoch: epoch },
              new Date(),
            );
            expect(performance.now() - start).toBeLessThan(1500);
            expect(
              (await db.endpoint.findUniqueOrThrow({ where: { id: model.Endpoint.id } }))
                .loadCounterEpoch,
            ).toBe(epoch - 1);
            const cold = await rankAffinityTargets({
              ...args(f),
              targets: [{ ...target(f), costPenalty: 17 }],
              scoreSingleTarget: true,
            });
            expect(cold.scores[f.target.id]).toBe(-17);
            const warmOther = await rankAffinityTargets({
              ...args(other),
              targets: [target(other)],
              scoreSingleTarget: true,
            });
            expect(warmOther.scores[other.target.id]).toBeGreaterThan(0);
            expect(
              await loadWarmSessions({
                ownerId: f.owner.id,
                capacityIds: [f.capacity.id],
                policy: { windowSeconds: 600, minTokens: 1 },
              }),
            ).toEqual(new Map());
            expect(
              (
                await loadWarmSessions({
                  ownerId: other.owner.id,
                  capacityIds: [other.capacity.id],
                  policy: { windowSeconds: 600, minTokens: 1 },
                })
              ).size,
            ).toBe(1);
            const [unknown] = await captureAffinityTargetGenerations([target(f)]);
            expect(unknown!.cacheGeneration).toBe("unknown-observed-reset");
            await expect(rememberAffinity({ ...args(f), target: unknown! })).rejects.toThrow(
              /generation has reset/,
            );
            manager.sendRelayRequest({
              cliDeviceId: session.cliDeviceId,
              endpointSlug: model.Endpoint.slug,
              requestId: crypto.randomUUID(),
              family: "chat.completions",
              method: "POST",
              path: "/v1/chat/completions",
              headers: {},
              timeoutMs: 1000,
            });
            expect(closes).toBe(0);
            expect(sent).toHaveLength(epoch - 1);
          } finally {
            release();
            await blocker;
          }
          // Only the owned background retry runs: no repeat load/reset event.
          // The epoch commits before the observation is acknowledged, and
          // observer recovery may still advance the generation for the same
          // reset. A completion racing either is correctly refused, so wait
          // until the reset has settled before capturing a fresh generation.
          await expect
            .poll(
              async () =>
                !pendingResets.size &&
                (await db.cacheAffinityObserver.count({
                  where: { capacityId: f.capacity.id, pending: true },
                })) === 0,
              { timeout: 5000 },
            )
            .toBe(true);
          expect(
            (await db.endpoint.findUniqueOrThrow({ where: { id: model.Endpoint.id } }))
              .loadCounterEpoch,
          ).toBe(epoch);
          const [fresh] = await captureAffinityTargetGenerations([target(f)]);
          expect(fresh!.cacheGeneration).not.toBe("unknown-observed-reset");
          await rememberAffinity({ ...args(f), target: fresh! });
          expect(
            (await rankAffinityTargets({ ...args(f), targets: [fresh!], scoreSingleTarget: true }))
              .scores[f.target.id],
          ).toBeGreaterThan(0);
        }
        let releaseShutdown!: () => void;
        let heldShutdown!: () => void;
        const shutdownHeld = new Promise<void>((resolve) => {
          heldShutdown = resolve;
        });
        const shutdownRelease = new Promise<void>((resolve) => {
          releaseShutdown = resolve;
        });
        const shutdownBlocker = production.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${f.capacity.id} FOR UPDATE`;
          heldShutdown();
          await shutdownRelease;
        });
        await shutdownHeld;
        try {
          await producer.noteKvEvictionResetSignal(
            session,
            { endpointSlug: model.Endpoint.slug, counterEpoch: 4 },
            new Date(),
          );
          const start = performance.now();
          await manager.closeRelaySessions();
          expect(performance.now() - start).toBeLessThan(1500);
          expect(manager.isDraining()).toBe(true);
          expect(
            (await db.endpoint.findUniqueOrThrow({ where: { id: model.Endpoint.id } }))
              .loadCounterEpoch,
          ).toBe(3);
        } finally {
          releaseShutdown();
          await shutdownBlocker;
        }
      } finally {
        manager.dispose();
      }
      // Registration, not a mocked epoch assignment, advances the durable restart fence.
      const beforeReconnect = (await captureAffinityTargetGenerations([target(f)]))[0]!;
      successor = new RelaySessionManager();
      await connectObserved(successor, f, socket);
      const [reconnected] = await captureAffinityTargetGenerations([target(f)]);
      expect(reconnected!.cacheGeneration).not.toBe(beforeReconnect.cacheGeneration);
      expect(
        (
          await rankAffinityTargets({
            ...args(f),
            targets: [reconnected!],
            scoreSingleTarget: true,
          })
        ).scores[f.target.id],
      ).toBe(0);
      await expect(rememberAffinity({ ...args(f), target: beforeReconnect })).rejects.toThrow(
        /generation has reset/,
      );
      await rememberAffinity({ ...args(f), target: reconnected! });
      expect(
        (
          await rankAffinityTargets({
            ...args(f),
            targets: [reconnected!],
            scoreSingleTarget: true,
          })
        ).scores[f.target.id],
      ).toBeGreaterThan(0);
      const replica = new RelaySessionManager();
      try {
        expect(replica.getActiveCliDeviceIds()).toEqual([]);
        expect(() =>
          replica.sendRelayRequest({
            cliDeviceId: session.cliDeviceId,
            endpointSlug: model.Endpoint.slug,
            requestId: crypto.randomUUID(),
            family: "chat.completions",
            method: "POST",
            path: "/v1/chat/completions",
            headers: {},
            timeoutMs: 1000,
          }),
        ).toThrow(/disconnected/);
        const seed = replica as unknown as {
          seedCounterEpochs(id: string): Promise<void>;
          kvCounterEpochByEndpoint: Map<string, number>;
        };
        await seed.seedCounterEpochs(session.cliDeviceId);
        expect(
          seed.kvCounterEpochByEndpoint.get(`${session.cliDeviceId}\0${model.Endpoint.slug}`),
        ).toBe(3);
      } finally {
        replica.dispose();
      }
    } finally {
      manager.dispose();
      successor?.dispose();
    }
  },
  30000,
);

integration(
  "unknown residency suppresses the whole real ranking term for all five siblings",
  async () => {
    const f = await fixture();
    const model = await db.discoveredModel.findUniqueOrThrow({
      where: { id: f.target.discoveredModelId! },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: f.owner.id,
        label: "core-large",
        runtimeIdentityKey: crypto.randomUUID(),
        runtimeModel: "core",
      },
    });
    const suffix = crypto.randomUUID();
    const secondModel = await db.discoveredModel.create({
      data: {
        userId: f.owner.id,
        endpointId: model.endpointId,
        upstreamModelId: suffix,
        encodedModelId: suffix,
      },
    });
    const second = await db.executionTarget.update({
      where: { discoveredModelId: secondModel.id },
      data: { inferenceCapacityId: capacity.id },
    });
    const targets = [f.target, second].map((target, i) => ({
      poolMemberId: `member-${i}`,
      executionTargetId: target.id,
      targetIdentity: "core",
      cacheGeneration: "",
      capacityId: target.inferenceCapacityId!,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
      engineKind: "VLLM" as const,
      kvBudgetTokens: i === 0 ? 100 : 10000,
      requestTokens: 100,
    }));
    const policy = {
      enabled: true,
      ttlSeconds: 60,
      maxRecords: 100,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
    };
    const params = {
      ownerId: f.owner.id,
      resourceOwnerId: f.owner.id,
      poolId: f.pools[0]!.id,
      surface: "openai-chat",
      payload: {
        model: "core",
        messages: [{ role: "user", content: "fresh conversation ".repeat(20) }],
      },
      targets,
      db: bounded.prisma,
    };
    expect(
      await production.$queryRaw(
        affinityResidencySql(
          f.owner.id,
          targets.map((t) => t.capacityId),
          new Date(),
        ),
      ),
    ).toEqual([]);
    const off = await rankAffinityTargets({ ...params, policy: { ...policy, residencyWeight: 0 } });
    const unknown = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    process.stdout.write(
      JSON.stringify({
        coreUnknownRanking: {
          initial: targets.map((t) => t.executionTargetId),
          off: off.orderedTargetIds,
          unknown: unknown.orderedTargetIds,
          unknownScores: unknown.scores,
        },
      }) + "\n",
    );
    expect(off.orderedTargetIds[0]).toBe(f.target.id);
    expect(unknown.orderedTargetIds).toEqual(off.orderedTargetIds);
    expect(unknown.scores).toEqual(off.scores);
    const continuationPayload = {
      messages: [
        { role: "user", content: "unknown-continuation" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "followup" },
      ],
    };
    const continuationMiss = await rankAffinityTargets({
      ...params,
      payload: continuationPayload,
      policy,
    });
    expect(continuationMiss.scores).toEqual(unknown.scores);
    await db.cacheAffinityResidency.createMany({
      data: targets.map((t) => ({
        executionTargetId: t.executionTargetId,
        userId: f.owner.id,
        complete: true,
      })),
    });
    const completeEmpty = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(completeEmpty.scores[f.target.id]).toBe(-100);
    expect(completeEmpty.scores[second.id]).toBe(-1);
    expect(completeEmpty.orderedTargetIds[0]).toBe(second.id);
    await db.cacheAffinityResidency.update({
      where: { executionTargetId: second.id },
      data: {
        entries: [
          {
            id: "resident",
            sessionId: "resident",
            tokens: 10000,
            expiresAt: "2099-01-01",
            cacheGeneration: "",
            poolId: f.pools[0]!.id,
          },
        ],
      },
    });
    const warm = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(warm.orderedTargetIds[0]).toBe(f.target.id);
    // Known occupancy, not the unknown fallback that happens to share its order.
    expect(warm.scores[second.id]).toBeLessThan(completeEmpty.scores[second.id]!);
    await db.cacheAffinityResidency.update({
      where: { executionTargetId: second.id },
      data: { complete: false },
    });
    const incomplete = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(incomplete.scores).toEqual(unknown.scores);
    await db.cacheAffinityResidency.update({
      where: { executionTargetId: second.id },
      data: { complete: true },
    });
    let unlock!: () => void;
    let signal!: () => void;
    const held = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = production.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE cache_affinity_residency IN ACCESS EXCLUSIVE MODE`;
      signal();
      await release;
    });
    await held;
    let timedOut: Awaited<ReturnType<typeof rankAffinityTargets>> | undefined;
    const started = Date.now();
    try {
      timedOut = await rankAffinityTargets({
        ...params,
        policy: { ...policy, residencyWeight: 100 },
      });
      expect(timedOut.orderedTargetIds).toEqual(off.orderedTargetIds);
      expect(timedOut.scores).toEqual(unknown.scores);
    } finally {
      unlock();
      await blocker;
    }
    const recovered = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(recovered.orderedTargetIds[0]).toBe(f.target.id);
    await rememberAffinity({
      ...params,
      payload: continuationPayload,
      policy,
      target: targets[0]!,
    });
    await db.cacheAffinityResidency.update({
      where: { executionTargetId: second.id },
      data: { complete: false },
    });
    const warmAffinity = await rankAffinityTargets({
      ...params,
      payload: continuationPayload,
      policy,
    });
    expect(warmAffinity.scores[f.target.id]).toBeGreaterThan(0);
    expect(warmAffinity.orderedTargetIds[0]).toBe(f.target.id);
    await db.cacheAffinityResidency.update({
      where: { executionTargetId: second.id },
      data: { complete: true },
    });
    process.stdout.write(
      JSON.stringify({
        coreUnknownInverses: {
          unknown: unknown.scores,
          completeEmpty: completeEmpty.scores,
          warm: warm.scores,
          incomplete: incomplete.scores,
          timedOut: timedOut!.scores,
          timeoutMs: Date.now() - started,
          recovered: recovered.scores,
        },
      }) + "\n",
    );
    // Independent sibling: >8 capacity inputs never reach SQL, yet affect scoring.
    const extraTargets = [];
    for (let i = 0; i < 7; i++) {
      const key = crypto.randomUUID();
      const extraCapacity = await db.inferenceCapacity.create({
        data: {
          userId: f.owner.id,
          label: `critic-extra-${i}`,
          runtimeIdentityKey: key,
          runtimeModel: "core",
        },
      });
      const extraModel = await db.discoveredModel.create({
        data: {
          userId: f.owner.id,
          endpointId: model.endpointId,
          upstreamModelId: key,
          encodedModelId: key,
        },
      });
      const extra = await db.executionTarget.update({
        where: { discoveredModelId: extraModel.id },
        data: { inferenceCapacityId: extraCapacity.id },
      });
      extraTargets.push({
        ...targets[0]!,
        executionTargetId: extra.id,
        poolMemberId: `extra-${i}`,
        capacityId: extraCapacity.id,
      });
    }
    const overInput = await rankAffinityTargets({
      ...params,
      targets: [...targets, ...extraTargets],
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(overInput.scores[f.target.id]).toBe(0);
    expect(overInput.scores[second.id]).toBe(0);
    // Independent sibling: 2 requested capacities expand to 9 execution targets.
    for (const extra of extraTargets)
      await db.executionTarget.update({
        where: { id: extra.executionTargetId },
        data: { inferenceCapacityId: f.capacity.id },
      });
    expect(
      await production.$queryRaw(
        affinityResidencySql(
          f.owner.id,
          targets.map((t) => t.capacityId),
          new Date(),
        ),
      ),
    ).toEqual([]);
    const overExpanded = await rankAffinityTargets({
      ...params,
      policy: { ...policy, residencyWeight: 100 },
    });
    expect(overExpanded.scores).toEqual(unknown.scores);
    process.stdout.write(
      JSON.stringify({
        criticFanout: {
          inputCapacities: 9,
          expandedTargets: 9,
          overInput: overInput.scores,
          overExpanded: overExpanded.scores,
        },
      }) + "\n",
    );
    await db.cacheAffinityResidency.deleteMany({ where: { userId: f.owner.id } });
  },
);
