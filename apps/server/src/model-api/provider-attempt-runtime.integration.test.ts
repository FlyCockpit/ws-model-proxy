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
      service.claimProviderHealthTrial(input),
      service.claimProviderHealthTrial(input),
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

    await expect(service.claimProviderHealthTrial(input)).resolves.toBe("HALF_OPEN");
    const recovered = await db.providerModel.findUniqueOrThrow({
      where: { id: model.id },
      select: { healthHalfOpenAt: true },
    });
    expect(recovered.healthHalfOpenAt?.getTime()).toBeGreaterThan(stale.getTime());
  });
});
