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

    const claims = await Promise.all([
      service.claimProviderHealthTrial({ ...input, attemptId: "probe-a", fencingToken: 1n }),
      service.claimProviderHealthTrial({ ...input, attemptId: "probe-b", fencingToken: 2n }),
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

    await expect(
      service.claimProviderHealthTrial({ ...input, attemptId: "probe-c", fencingToken: 3n }),
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
    const owner = { attemptId: `owner-${suffix}`, fencingToken: 11n };
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
    const [alive, competitor] = await Promise.all([
      service.heartbeatProviderAttempt({ ...owner, extensionMs: 15 * 60_000 }),
      service.claimProviderHealthTrial({
        ...target,
        attemptId: `competitor-${suffix}`,
        fencingToken: 12n,
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
    const successor = { attemptId: `successor-${suffix}`, fencingToken: 13n };
    await expect(service.claimProviderHealthTrial({ ...target, ...successor })).resolves.toBe(
      "HALF_OPEN",
    );
    await expect(
      service.heartbeatProviderAttempt({ ...owner, extensionMs: 15 * 60_000 }),
    ).resolves.toBe(false);
    const reclaimed = await db.providerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(reclaimed.healthHalfOpenAttemptId).toBe(successor.attemptId);
    expect(reclaimed.healthHalfOpenFencingToken).toBe(successor.fencingToken);
  });
});
