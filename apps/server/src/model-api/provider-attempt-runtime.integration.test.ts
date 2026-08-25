import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn(
    "[provider-attempt-runtime] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured",
  );

integration("provider half-open recovery", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  let service: typeof import("./provider-attempt-runtime.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    service = await import("./provider-attempt-runtime.js");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("serializes competing probes and reclaims a crashed probe after its bounded lease", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Health recovery proof", email: `health-${suffix}@example.test` },
    });
    const expiredCooldown = new Date(Date.now() - 120_000);
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `health-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
        healthStatus: "UNAVAILABLE",
        healthNextRetryAt: expiredCooldown,
      },
    });
    const model = await db.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: suffix,
        healthStatus: "UNAVAILABLE",
        healthNextRetryAt: expiredCooldown,
      },
    });
    const input = {
      userId: user.id,
      providerAccountId: account.id,
      providerModelId: model.id,
    };
    const [probeAFence, probeBFence] = await Promise.all([
      service.allocateProviderFence({ userId: user.id, providerAccountId: account.id }),
      service.allocateProviderFence({ userId: user.id, providerAccountId: account.id }),
    ]);

    const claims = await Promise.all([
      service.claimProviderHealthTrial({
        ...input,
        attemptId: "probe-a",
        fencingToken: probeAFence,
      }),
      service.claimProviderHealthTrial({
        ...input,
        attemptId: "probe-b",
        fencingToken: probeBFence,
      }),
    ]);

    expect(claims.sort()).toEqual(["COOLDOWN", "HALF_OPEN"]);
    const claimedAt = await db.providerAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { healthHalfOpenAt: true },
    });
    expect(claimedAt.healthHalfOpenAt).not.toBeNull();

    const stale = new Date(Date.now() - service.PROVIDER_HALF_OPEN_LEASE_MS - 1_000);
    await db.$transaction([
      db.providerAccount.update({
        where: { id: account.id },
        data: { healthHalfOpenAt: stale },
      }),
      db.providerModel.update({
        where: { id: model.id },
        data: { healthHalfOpenAt: stale },
      }),
    ]);

    const probeCFence = await service.allocateProviderFence({
      userId: user.id,
      providerAccountId: account.id,
    });
    await expect(
      service.claimProviderHealthTrial({
        ...input,
        attemptId: "probe-c",
        fencingToken: probeCFence,
      }),
    ).resolves.toBe("HALF_OPEN");
    const recovered = await db.providerModel.findUniqueOrThrow({
      where: { id: model.id },
      select: { healthHalfOpenAt: true },
    });
    expect(recovered.healthHalfOpenAt?.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("keeps a live fenced probe exclusive while allowing a bounded orphan reclaim", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Health lease owner proof", email: `health-owner-${suffix}@example.test` },
    });
    const expiredCooldown = new Date(Date.now() - 120_000);
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `health-owner-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
        healthStatus: "UNAVAILABLE",
        healthNextRetryAt: expiredCooldown,
      },
    });
    const model = await db.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: suffix,
        healthStatus: "UNAVAILABLE",
        healthNextRetryAt: expiredCooldown,
      },
    });
    const owner = {
      attemptId: `owner-${suffix}`,
      fencingToken: await service.allocateProviderFence({
        userId: user.id,
        providerAccountId: account.id,
      }),
    };
    await db.providerAttempt.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        requestId: `request-${suffix}`,
        ...owner,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        accountingVersion: "test-v1",
      },
    });
    const target = {
      userId: user.id,
      providerAccountId: account.id,
      providerModelId: model.id,
    };
    await expect(service.claimProviderHealthTrial({ ...target, ...owner })).resolves.toBe(
      "HALF_OPEN",
    );

    // Even immediately before the orphan boundary, either lock ordering sees
    // the existing live timestamp or the owner's atomic renewal.
    const almostStale = new Date(Date.now() - service.PROVIDER_HALF_OPEN_LEASE_MS + 5_000);
    await db.$transaction([
      db.providerAccount.update({
        where: { id: account.id },
        data: { healthHalfOpenAt: almostStale },
      }),
      db.providerModel.update({
        where: { id: model.id },
        data: { healthHalfOpenAt: almostStale },
      }),
    ]);
    const competitorFence = await service.allocateProviderFence({
      userId: user.id,
      providerAccountId: account.id,
    });
    const [alive, competitor] = await Promise.all([
      service.heartbeatProviderAttempt({ ...owner, extensionMs: 15 * 60_000 }),
      service.claimProviderHealthTrial({
        ...target,
        attemptId: `competitor-${suffix}`,
        fencingToken: competitorFence,
      }),
    ]);
    expect(alive).toBe(true);
    expect(competitor).toBe("COOLDOWN");
    const renewed = await db.providerModel.findUniqueOrThrow({ where: { id: model.id } });
    expect(renewed.healthHalfOpenAttemptId).toBe(owner.attemptId);
    expect(renewed.healthHalfOpenFencingToken).toBe(owner.fencingToken);

    // Once the owner stops heartbeating, reclamation remains bounded and
    // installs a new fence on both rows.
    const orphaned = new Date(Date.now() - service.PROVIDER_HALF_OPEN_LEASE_MS - 1_000);
    await db.$transaction([
      db.providerAccount.update({
        where: { id: account.id },
        data: { healthHalfOpenAt: orphaned },
      }),
      db.providerModel.update({ where: { id: model.id }, data: { healthHalfOpenAt: orphaned } }),
    ]);
    const successor = {
      attemptId: `successor-${suffix}`,
      fencingToken: await service.allocateProviderFence({
        userId: user.id,
        providerAccountId: account.id,
      }),
    };
    await db.providerAttempt.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        requestId: `successor-request-${suffix}`,
        ...successor,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        accountingVersion: "test-v1",
      },
    });
    await expect(service.claimProviderHealthTrial({ ...target, ...successor })).resolves.toBe(
      "HALF_OPEN",
    );
    await expect(
      service.heartbeatProviderAttempt({ ...owner, extensionMs: 15 * 60_000 }),
    ).resolves.toBe(false);
    const reclaimed = await db.providerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(reclaimed.healthHalfOpenAttemptId).toBe(successor.attemptId);
    expect(reclaimed.healthHalfOpenFencingToken).toBe(successor.fencingToken);

    // B completes and clears the nullable owner tuple. The durable watermark
    // must still reject A's delayed failure instead of re-opening cooldown.
    await service.recordProviderOutcome({
      ...target,
      ...successor,
      success: true,
    });
    await service.recordProviderOutcome({
      ...target,
      ...owner,
      success: false,
      failureClass: "TRANSPORT",
    });
    const afterLateOwner = await db.providerModel.findUniqueOrThrow({ where: { id: model.id } });
    expect(afterLateOwner.healthStatus).toBe("HEALTHY");
    expect(afterLateOwner.healthFailureCount).toBe(0);
    expect(afterLateOwner.healthNextRetryAt).toBeNull();
    expect(afterLateOwner.healthHalfOpenAttemptId).toBeNull();
    expect(afterLateOwner.healthFencingWatermark).toBe(successor.fencingToken);
  });

  it("orders concurrent READY outcomes without blocking either dispatch", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "READY ordering proof", email: `ready-order-${suffix}@example.test` },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `ready-order-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: suffix,
      },
    });
    const target = {
      userId: user.id,
      providerAccountId: account.id,
      providerModelId: model.id,
    };
    const olderFence = await service.allocateProviderFence({
      userId: user.id,
      providerAccountId: account.id,
    });
    const newerFence = await service.allocateProviderFence({
      userId: user.id,
      providerAccountId: account.id,
    });
    await db.providerAttempt.createMany({
      data: [
        {
          userId: user.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          requestId: `ready-old-request-${suffix}`,
          attemptId: `ready-old-${suffix}`,
          fencingToken: olderFence,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          accountingVersion: "test-v1",
        },
        {
          userId: user.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          requestId: `ready-new-request-${suffix}`,
          attemptId: `ready-new-${suffix}`,
          fencingToken: newerFence,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          accountingVersion: "test-v1",
        },
      ],
    });

    await expect(
      Promise.all([
        service.claimProviderHealthTrial({
          ...target,
          attemptId: `ready-old-${suffix}`,
          fencingToken: olderFence,
        }),
        service.claimProviderHealthTrial({
          ...target,
          attemptId: `ready-new-${suffix}`,
          fencingToken: newerFence,
        }),
      ]),
    ).resolves.toEqual(["READY", "READY"]);

    await service.recordProviderOutcome({
      ...target,
      attemptId: `ready-new-${suffix}`,
      fencingToken: newerFence,
      success: true,
    });
    await service.recordProviderOutcome({
      ...target,
      attemptId: `ready-old-${suffix}`,
      fencingToken: olderFence,
      success: false,
      failureClass: "TRANSPORT",
    });

    const [storedAccount, storedModel] = await Promise.all([
      db.providerAccount.findUniqueOrThrow({ where: { id: account.id } }),
      db.providerModel.findUniqueOrThrow({ where: { id: model.id } }),
    ]);
    expect(storedAccount.healthStatus).toBe("HEALTHY");
    expect(storedModel.healthStatus).toBe("HEALTHY");
    expect(storedAccount.healthFencingWatermark).toBe(newerFence);
    expect(storedModel.healthFencingWatermark).toBe(newerFence);
  });

  it("rejects an outcome whose attempt terminalizes while outcome processing is deferred", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Outcome race proof", email: `outcome-race-${suffix}@example.test` },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `outcome-race-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const attemptId = `outcome-race-${suffix}`;
    const fencingToken = await service.allocateProviderFence({
      userId: user.id,
      providerAccountId: account.id,
    });
    await db.providerAttempt.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        requestId: `outcome-race-request-${suffix}`,
        attemptId,
        fencingToken,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        accountingVersion: "test-v1",
      },
    });

    let releaseTerminal!: () => void;
    const terminalMayCommit = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let terminalLocked!: () => void;
    const terminalHasLock = new Promise<void>((resolve) => {
      terminalLocked = resolve;
    });
    const terminal = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM provider_attempt WHERE "attemptId" = ${attemptId} AND "fencingToken" = ${fencingToken} FOR UPDATE`;
      await tx.providerAttempt.update({
        where: { attemptId_fencingToken: { attemptId, fencingToken } },
        data: { state: "FAILED", terminalAt: new Date(), terminalReason: "RACE_WINNER" },
      });
      terminalLocked();
      await terminalMayCommit;
    });
    await terminalHasLock;
    const outcome = service.recordProviderOutcome({
      userId: user.id,
      providerAccountId: account.id,
      providerModelId: model.id,
      attemptId,
      fencingToken,
      success: false,
      failureClass: "TRANSPORT",
    });
    releaseTerminal();
    await terminal;
    await expect(outcome).resolves.toBe(false);
    const storedModel = await db.providerModel.findUniqueOrThrow({ where: { id: model.id } });
    expect(storedModel.healthStatus).toBe("UNKNOWN");
    expect(storedModel.healthFailureCount).toBe(0);
  });

  it("installs durable watermark defaults and database ordering constraints", async () => {
    if (!db) return;
    const constraints = await db.$queryRaw<Array<{ table_name: string; definition: string }>>`
      SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.conname IN ('provider_account_shape_check', 'provider_model_shape_check')
      ORDER BY rel.relname
    `;
    expect(constraints).toHaveLength(2);
    expect(constraints.find((row) => row.table_name === "provider_account")?.definition).toContain(
      '"nextFencingToken" >= "healthFencingWatermark"',
    );
    for (const constraint of constraints) {
      expect(constraint.definition).toMatch(
        /"healthFencingWatermark"\s*>=\s*COALESCE\("healthHalfOpenFencingToken"/,
      );
    }
    const [invalidAccountRows, invalidModelRows] = await Promise.all([
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM provider_account
        WHERE "nextFencingToken" < "healthFencingWatermark"
           OR "healthFencingWatermark" < COALESCE("healthHalfOpenFencingToken", 0)
      `,
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM provider_model
        WHERE "healthFencingWatermark" < COALESCE("healthHalfOpenFencingToken", 0)
      `,
    ]);
    expect(invalidAccountRows[0]?.count).toBe(0n);
    expect(invalidModelRows[0]?.count).toBe(0n);

    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Watermark constraint proof", email: `watermark-${suffix}@example.test` },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `watermark-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    expect(account.healthFencingWatermark).toBe(0n);
    await expect(
      db.providerAccount.update({
        where: { id: account.id },
        data: { nextFencingToken: 1n, healthFencingWatermark: 2n },
      }),
    ).rejects.toThrow();
  });
});
