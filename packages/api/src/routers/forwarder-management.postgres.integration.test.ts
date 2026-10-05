import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("guarded pool setup with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./forwarder-management");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    const [, router] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./forwarder-management"),
    ]);
    modules = { prisma: createFixturePrismaClient(databaseUrl!), router };
  });

  afterAll(async () => {
    if (!modules) return;
    modules.router.setGuardedSetupTestFailureInjector(undefined);
    // Successful guarded setup writes append-only provider audit history.
    // Unique fixture identities keep retained rows isolated in shared CI.
  });

  it("rolls back every durable guarded-setup row after a deterministic late failure", async () => {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Guarded router rollback",
        email: `guarded-router-${suffix}@example.test`,
        slug: `guarded-router-${suffix}`,
      },
    });
    const cli = await modules.prisma.cliDevice.create({
      data: { userId: user.id, slug: `cli-${suffix}` },
    });
    const endpoint = await modules.prisma.endpoint.create({
      data: {
        userId: user.id,
        cliDeviceId: cli.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          responses: { supported: true, streaming: true },
        },
      },
    });
    const local = await modules.prisma.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: endpoint.id,
        upstreamModelId: "local-model",
        encodedModelId: "local-model",
      },
    });
    const capacity = await modules.prisma.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `capacity-${suffix}`,
        runtimeIdentityKey: `runtime-${suffix}`,
        runtimeModel: "local-model",
        hardConcurrencyLimit: 2,
        physicalMaxContext: 65_536,
      },
    });
    const localTarget = await modules.prisma.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: local.id },
    });
    await modules.prisma.executionTarget.update({
      where: { id: localTarget.id },
      data: { inferenceCapacityId: capacity.id },
    });
    const account = await modules.prisma.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "openai",
        label: `provider-${suffix}`,
        baseUrl: "https://provider.example.test/v1",
        endpointIdentity: "https://provider.example.test/v1",
        authType: "BEARER",
        status: "ACTIVE",
        enabled: false,
      },
    });
    await modules.prisma.$transaction(async (transaction) => {
      const credential = await transaction.providerCredential.create({
        data: {
          userId: user.id,
          providerAccountId: account.id,
          credentialType: "BEARER",
          keyVersion: "test-v1",
          ciphertext: new Uint8Array([1]),
          nonce: crypto.getRandomValues(new Uint8Array(12)),
          authTag: new Uint8Array(16),
          displaySuffix: "test",
        },
      });
      await transaction.providerAccount.update({
        where: { id: account.id },
        data: { currentCredentialId: credential.id, enabled: true },
      });
    });
    const provider = await modules.prisma.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: "provider-model",
        enabled: true,
        nativeCapabilities: { surfaces: ["openai-responses"], streaming: true },
      },
    });
    await modules.prisma.providerPricingVersion.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: provider.id,
        version: "test-v1",
        currency: "USD",
        pricing: { ratesPerMillion: { input: "1", output: "1" } },
        effectiveAt: new Date(Date.now() - 60_000),
      },
    });

    const session = {
      user,
      session: {
        id: `session-${suffix}`,
        userId: user.id,
        token: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "integration",
      },
    } as Session;
    const handler = new RPCHandler(modules.router.forwarderManagementRouter);
    const link = new RPCLink({
      url: "http://integration.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session } satisfies Context,
        });
        return result.matched ? result.response : new Response(null, { status: 404 });
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof modules.router.forwarderManagementRouter>
    >;
    modules.router.setGuardedSetupTestFailureInjector(() => {
      throw new Error("injected after guarded audit writes");
    });

    await expect(
      client.createGuardedModelPool({
        slug: `guarded-${suffix}`,
        name: "Guarded rollback",
        localModelIds: [local.id],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 32_768,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,

        advanced: {
          physicalCountStrategy: "ENGINE_REPORTED",
          contextMargin: 1_024,
          borrowPolicy: "NEVER",
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: true,
          affinity: {
            enabled: true,
            ttlSeconds: 7_200,
            maxRecords: 20_000,
            prefixWeight: 110,
            conversationWeight: 160,
            confirmedCacheWeight: 260,
            loadPenaltyWeight: 120,
          },
          memberOverrides: [
            {
              discoveredModelId: local.id,
              concurrency: { mode: "LIMITED", limitValue: 1 },
              reservedSlots: 0,
              borrowPolicy: "NEVER",
              waitBudget: { mode: "LIMITED", limitValue: 15_000 },
              contextCeiling: { mode: "LIMITED", limitValue: 31_744 },
              contextMargin: 1_024,
            },
          ],
        },
        providerModels: [
          {
            providerModelId: provider.id,
            concurrencyLimit: 1,
            dailySpendLimit: "5",
            budgetRules: {
              concurrency: { mode: "LIMITED", limitValue: 1 },
              tokensPerAttempt: { mode: "LIMITED", limitValue: 100_000 },
              tokensPerDay: { mode: "LIMITED", limitValue: 1_000_000 },
              tokensPerMonth: { mode: "LIMITED", limitValue: 10_000_000 },
              tokensLifetime: { mode: "UNLIMITED", limitValue: null },
              spendPerDay: { mode: "LIMITED", limitValue: "5" },
              spendPerMonth: { mode: "LIMITED", limitValue: "100" },
            },
          },
        ],
      }),
    ).rejects.toThrow();
    modules.router.setGuardedSetupTestFailureInjector(undefined);

    const pool = await modules.prisma.modelPool.findFirst({
      where: { userId: user.id, slug: `guarded-${suffix}` },
    });
    expect(pool).toBeNull();
    expect(
      await modules.prisma.poolMember.count({
        where: { poolId: { not: "" }, ModelPool: { userId: user.id } },
      }),
    ).toBe(0);
    expect(await modules.prisma.providerBudgetPolicy.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await modules.prisma.providerBudgetRule.count({ where: { Policy: { userId: user.id } } }),
    ).toBe(0);
    expect(await modules.prisma.providerAuditEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await modules.prisma.capacityAuditEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await modules.prisma.executionTarget.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await modules.prisma.inferenceCapacity.findUnique({
        where: { id: capacity.id },
        select: { countStrategy: true },
      }),
    ).toEqual({ countStrategy: "CONSERVATIVE_ESTIMATE" });

    await client.createGuardedModelPool({
      slug: `guarded-success-${suffix}`,
      name: "Guarded success",
      localModelIds: [local.id],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 1,
      memberContextCeiling: 32_768,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,

      advanced: {
        physicalCountStrategy: "ENGINE_REPORTED",
        contextMargin: 1_024,
        borrowPolicy: "NEVER",
        protocolAdaptationEnabled: true,
        allowLossyDeveloperRoleCollapse: true,
        affinity: {
          enabled: true,
          ttlSeconds: 7_200,
          maxRecords: 20_000,
          prefixWeight: 110,
          conversationWeight: 160,
          confirmedCacheWeight: 260,
          loadPenaltyWeight: 120,
        },
        memberOverrides: [
          {
            discoveredModelId: local.id,
            concurrency: { mode: "LIMITED", limitValue: 1 },
            reservedSlots: 0,
            borrowPolicy: "NEVER",
            waitBudget: { mode: "LIMITED", limitValue: 15_000 },
            contextCeiling: { mode: "LIMITED", limitValue: 31_744 },
            contextMargin: 1_024,
          },
        ],
      },
      providerModels: [
        {
          providerModelId: provider.id,
          concurrencyLimit: 1,
          dailySpendLimit: "5",
          budgetRules: {
            concurrency: { mode: "LIMITED", limitValue: 1 },
            tokensPerAttempt: { mode: "LIMITED", limitValue: 100_000 },
            tokensPerDay: { mode: "LIMITED", limitValue: 1_000_000 },
            tokensPerMonth: { mode: "LIMITED", limitValue: 10_000_000 },
            tokensLifetime: { mode: "UNLIMITED", limitValue: null },
            spendPerDay: { mode: "LIMITED", limitValue: "5" },
            spendPerMonth: { mode: "LIMITED", limitValue: "100" },
          },
        },
      ],
    });
    const persisted = await modules.prisma.modelPool.findFirstOrThrow({
      where: { userId: user.id, slug: `guarded-success-${suffix}` },
      include: {
        PoolMembers: { orderBy: { tier: "asc" } },
        ProviderBudgetPolicies: { include: { Rules: true } },
      },
    });
    expect(persisted).toMatchObject({
      protocolAdaptationEnabled: true,
      allowLossyDeveloperRoleCollapse: true,
      capacityContextMargin: 1_024,
      capacityBorrowPolicy: "NEVER",
      affinityEnabled: true,
      affinityTtlSeconds: 7_200,
      affinityMaxRecords: 20_000,
      affinityPrefixWeight: 110,
      affinityConversationWeight: 160,
      affinityConfirmedCacheWeight: 260,
      affinityLoadPenaltyWeight: 120,
      affinityResidencyWeight: 100,
    });
    expect(persisted.PoolMembers.find((member) => member.tier === "PRIMARY")).toMatchObject({
      capacityConcurrencyMode: "LIMITED",
      capacityConcurrencyLimit: 1,
      capacityReservedSlots: 0,
      capacityBorrowPolicy: "NEVER",
      capacityWaitBudgetMode: "LIMITED",
      capacityWaitBudgetMs: 15_000,
      capacityContextCeilingMode: "LIMITED",
      capacityContextCeiling: 31_744,
      capacityContextMargin: 1_024,
    });
    expect(persisted.ProviderBudgetPolicies).toHaveLength(1);
    expect(persisted.ProviderBudgetPolicies[0]?.Rules).toHaveLength(7);
    expect(
      persisted.ProviderBudgetPolicies[0]?.Rules.map((rule) => [
        rule.metric,
        rule.period,
        rule.mode,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["CONCURRENCY", "PER_ATTEMPT", "LIMITED"],
        ["TOKENS", "PER_ATTEMPT", "LIMITED"],
        ["TOKENS", "UTC_DAY", "LIMITED"],
        ["TOKENS", "UTC_MONTH", "LIMITED"],
        ["TOKENS", "LIFETIME", "UNLIMITED"],
        ["SPEND", "UTC_DAY", "LIMITED"],
        ["SPEND", "UTC_MONTH", "LIMITED"],
      ]),
    );
    expect(
      await modules.prisma.inferenceCapacity.findUnique({
        where: { id: capacity.id },
        select: { countStrategy: true },
      }),
    ).toEqual({ countStrategy: "ENGINE_REPORTED" });
  });
});

/**
 * Hardened-schema behaviors the routing and budget code relies on, pinned
 * against a real database installed by `db:push` (prisma push + hardening).
 */
integration("schema hardening behaviors with real PostgreSQL", () => {
  const fixtures = databaseUrl ? createFixturePrismaClient(databaseUrl) : undefined;
  const userIds: string[] = [];
  const hardeningScript = fileURLToPath(
    new URL("../../../db/scripts/apply-schema-hardening.mjs", import.meta.url),
  );

  afterAll(async () => {
    if (!fixtures) return;
    for (const id of userIds) await fixtures.user.deleteMany({ where: { id } });
    await fixtures.$disconnect();
  });

  function db() {
    if (!fixtures) throw new Error("fixtures client requires SCHEMA_VALIDATION_DATABASE_URL");
    return fixtures;
  }

  async function user(tag: string) {
    const suffix = `${tag}-${crypto.randomUUID()}`;
    const row = await db().user.create({
      data: { name: tag, email: `${suffix}@example.test`, slug: suffix },
    });
    userIds.push(row.id);
    return row;
  }

  /** A pool with `count` PRIMARY members, one device/endpoint/model each. */
  async function poolWithMembers(tag: string, count: number) {
    const owner = await user(tag);
    const pool = await db().modelPool.create({
      data: { userId: owner.id, slug: `pool-${crypto.randomUUID()}`.slice(0, 60), name: "pool" },
    });
    const members = [];
    for (let index = 0; index < count; index++) {
      const device = await db().cliDevice.create({
        data: { userId: owner.id, slug: `desk-${index}` },
      });
      const endpoint = await db().endpoint.create({
        data: { userId: owner.id, cliDeviceId: device.id, slug: `ep-${index}`, label: "ep" },
      });
      const model = await db().discoveredModel.create({
        data: {
          userId: owner.id,
          endpointId: endpoint.id,
          upstreamModelId: "m",
          encodedModelId: "m",
        },
      });
      members.push(
        await db().poolMember.create({ data: { poolId: pool.id, discoveredModelId: model.id } }),
      );
    }
    return { owner, pool, members };
  }

  function insertRule(input: {
    poolId: string;
    position: number;
    memberId: string | null;
    exclude: boolean;
    labelsSql: "NULL" | "json-null" | "object";
  }) {
    // A null parameter is SQL NULL; the text 'null' casts to a JSON null.
    const labels =
      input.labelsSql === "NULL" ? null : input.labelsSql === "json-null" ? "null" : '{"gpu":"0"}';
    return db().$executeRaw`
      INSERT INTO pool_routing_rule
        (id, "poolId", position, metric, labels, aggregate, op, "threshold", effect, "memberId", exclude)
      VALUES
        (${crypto.randomUUID()}, ${input.poolId}, ${input.position}, 'gpu_util', ${labels}::jsonb,
         'max', '>', 90, 'avoid', ${input.memberId}, ${input.exclude})`;
  }

  async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      const code = (error as { meta?: { code?: unknown }; code?: unknown }).meta?.code;
      if (typeof code === "string") return code;
      const message = error instanceof Error ? error.message : String(error);
      return /\b(2\d{4}|23514)\b/.exec(message)?.[1] ?? message;
    }
  }

  it("stores a label-less routing rule as SQL NULL and rejects JSON null labels", async () => {
    const { pool } = await poolWithMembers("rule-labels", 1);
    await insertRule({
      poolId: pool.id,
      position: 0,
      memberId: null,
      exclude: false,
      labelsSql: "NULL",
    });
    await insertRule({
      poolId: pool.id,
      position: 1,
      memberId: null,
      exclude: false,
      labelsSql: "object",
    });
    const rows = await db().$queryRaw<
      { position: number; sqlNull: boolean; kind: string | null }[]
    >`
      SELECT position, labels IS NULL AS "sqlNull", jsonb_typeof(labels) AS kind
        FROM pool_routing_rule WHERE "poolId" = ${pool.id} ORDER BY position`;
    expect(rows).toEqual([
      { position: 0, sqlNull: true, kind: null },
      { position: 1, sqlNull: false, kind: "object" },
    ]);

    const refused = await sqlState(() =>
      insertRule({
        poolId: pool.id,
        position: 2,
        memberId: null,
        exclude: false,
        labelsSql: "json-null",
      }),
    );
    expect(refused).toMatch(/23514|pool_routing_rule_shape_check/);
  });

  it("deletes a member's targeted rules and widens its exclude rules when it is deleted", async () => {
    const {
      pool,
      members: [gone, kept],
    } = await poolWithMembers("rule-member-delete", 2);
    if (!gone || !kept) throw new Error("members missing");
    await insertRule({
      poolId: pool.id,
      position: 0,
      memberId: gone.id,
      exclude: false,
      labelsSql: "NULL",
    });
    await insertRule({
      poolId: pool.id,
      position: 1,
      memberId: gone.id,
      exclude: true,
      labelsSql: "NULL",
    });
    await insertRule({
      poolId: pool.id,
      position: 2,
      memberId: kept.id,
      exclude: false,
      labelsSql: "NULL",
    });

    await db().$executeRaw`DELETE FROM pool_member WHERE id = ${gone.id}`;

    const rows = await db().$queryRaw<
      { position: number; memberId: string | null; exclude: boolean }[]
    >`SELECT position, "memberId", exclude FROM pool_routing_rule
       WHERE "poolId" = ${pool.id} ORDER BY position`;
    expect(rows).toEqual([
      // The exclude rule now applies pool-wide; the targeted rule is gone.
      { position: 1, memberId: null, exclude: false },
      { position: 2, memberId: kept.id, exclude: false },
    ]);
    const [fk] = await db().$queryRaw<{ confdeltype: string }[]>`
      SELECT confdeltype::text AS confdeltype FROM pg_constraint
       WHERE conname = 'pool_routing_rule_memberId_fkey'`;
    expect(fk?.confdeltype).toBe("n");
  });

  it("keeps the newest-first residency index on non-prefix affinity rows", async () => {
    const [index] = await db().$queryRaw<{ definition: string }[]>`
      SELECT pg_get_indexdef('cache_affinity_record_residency'::regclass) AS definition`;
    expect(index?.definition).toMatch(
      /ON public\.cache_affinity_record USING btree \("userId", "executionTargetId", "expiresAt" DESC, id DESC\) WHERE \("prefixDigest" IS NULL\)$/,
    );
  });

  it("backfills a legacy POOL_GRANT cap's grantee past the transition trigger and reinstalls it", async () => {
    const { owner, pool } = await poolWithMembers("grant-backfill", 0);
    const grantee = await user("grant-backfill-grantee");
    const grant = await db().poolGrant.create({
      data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
    });
    const policyId = crypto.randomUUID();
    const triggerInstalled = async () =>
      (
        await db().$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_trigger
           WHERE tgname = 'provider_budget_policy_transition' AND NOT tgisinternal`
      )[0]?.count;
    expect(await triggerInstalled()).toBe(1);

    // Stage the pre-rekey state: a POOL_GRANT policy that only knows its grant
    // id. The live transition trigger stays installed, so a backfill that did
    // not drop it first would fail ("permits only controlled activation").
    await db().$transaction([
      db()
        .$executeRaw`ALTER TABLE provider_budget_policy DROP CONSTRAINT provider_budget_policy_scope_check`,
      db()
        .$executeRaw`ALTER TABLE provider_budget_policy DISABLE TRIGGER provider_budget_policy_graph_consistency`,
      db().$executeRaw`
        INSERT INTO provider_budget_policy (id, "userId", "scopeType", "poolId", "poolGrantId", "granteeUserId")
        VALUES (${policyId}, ${owner.id}, 'POOL_GRANT', ${pool.id}, ${grant.id}, NULL)`,
      db()
        .$executeRaw`ALTER TABLE provider_budget_policy ENABLE TRIGGER provider_budget_policy_graph_consistency`,
    ]);
    try {
      await expect(
        sqlState(
          () =>
            db()
              .$executeRaw`UPDATE provider_budget_policy SET "granteeUserId" = ${grantee.id} WHERE id = ${policyId}`,
        ),
      ).resolves.toMatch(/55000|controlled activation/);
    } finally {
      await promisify(execFile)(process.execPath, [hardeningScript], {
        env: { ...process.env, DATABASE_URL: databaseUrl, SCHEMA_HARDENING_FORCE: "1" },
      });
    }

    const policy = await db().providerBudgetPolicy.findUniqueOrThrow({
      where: { id: policyId },
      select: { granteeUserId: true, poolGrantId: true },
    });
    expect(policy).toEqual({ granteeUserId: grantee.id, poolGrantId: grant.id });
    expect(await triggerInstalled()).toBe(1);
    const [scopeCheck] = await db().$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'provider_budget_policy_scope_check'`;
    expect(scopeCheck?.definition).toContain(`"granteeUserId" IS NOT NULL`);
    // The restored check refuses a fresh grantee-less POOL_GRANT row again.
    await expect(
      sqlState(
        () => db().$executeRaw`
          INSERT INTO provider_budget_policy (id, "userId", "scopeType", "poolId", "poolGrantId")
          VALUES (${crypto.randomUUID()}, ${owner.id}, 'POOL_GRANT', ${pool.id}, ${grant.id})`,
      ),
    ).resolves.toMatch(/23514|budget policy grant|scope_check/);
  });
});
