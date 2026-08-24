import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[capacity-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("PostgreSQL capacity admission primitives", () => {
  it("serializes the same stable capacity lock across independent clients", async () => {
    if (!databaseUrl) return;
    const first = createPrismaClient(databaseUrl);
    const second = createPrismaClient(databaseUrl);
    const order: string[] = [];
    try {
      const a = first.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-proof"}, 0))`;
        order.push("first-lock");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first-release");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const b = second.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-proof"}, 0))`;
        order.push("second-lock");
      });
      await Promise.all([a, b]);
      expect(order).toEqual(["first-lock", "first-release", "second-lock"]);
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });
});
