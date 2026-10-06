import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof that every row the operator audit writer queues passes
 * the `deployment_operator_event_shape` CHECK (outcomes, actions, exit codes),
 * and that rows of a user that does not exist are not written.
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

integration("deployment operator audit with real PostgreSQL", () => {
  let db: ReturnType<typeof createPrismaClient>;
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let audit: typeof import("./operator-audit.js");
  let userId = "";

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    db = createPrismaClient(databaseUrl);
    fixture = createFixturePrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await fixture.user.create({
      data: { name: "operator-audit", email: `${suffix}@example.test`, slug: `op-${suffix}` },
    });
    userId = user.id;
    audit = await import("./operator-audit.js");
    audit.resetDeploymentOperatorAuditForTests();
  });

  afterAll(async () => {
    await db?.deploymentOperatorEvent.deleteMany({ where: { userId } });
    if (userId) await fixture?.user.delete({ where: { id: userId } });
    await Promise.all([db?.$disconnect(), fixture?.$disconnect()]);
  });

  it("writes every outcome the session manager records", async () => {
    const base = { userId, instanceId: "inst", stepId: "step", cliDeviceId: "dev", rank: 3 };
    const outcomes = [
      ["prepare", "opened", undefined],
      ["start", "accepted", undefined],
      ["after_join", "failed", undefined],
      ["stop", "closed", 4],
      ["start", "declined", undefined],
      ["start", "cancelled", undefined],
      ["stop", "auto_settled", undefined],
      ["start", "succeeded", undefined],
    ] as const;
    for (const [action, outcome, exitCode] of outcomes)
      audit.recordDeploymentOperatorEvent({
        ...base,
        action,
        outcome,
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    audit.recordDeploymentOperatorEvent({
      ...base,
      userId: "no-such-user",
      action: "start",
      outcome: "opened",
    });
    await audit.flushDeploymentOperatorAudit();
    const rows = await db.deploymentOperatorEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => row.outcome).sort()).toEqual(outcomes.map(([, o]) => o).sort());
    expect(rows.find((row) => row.outcome === "closed")?.exitCode).toBe(4);
    expect(await db.deploymentOperatorEvent.count({ where: { userId: "no-such-user" } })).toBe(0);
    expect(audit.deploymentOperatorAuditDroppedCount()).toBe(1);
  });
});
