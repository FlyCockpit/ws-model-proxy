import prisma from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import { assertDatabaseBackfilled } from "./database-backfill-startup.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const db = prisma as unknown as ReturnType<typeof mockDeep<typeof prisma>>;

describe("startup database backfill guard", () => {
  beforeEach(() => mockReset(db));

  it("accepts converted rows", async () => {
    db.$queryRaw.mockResolvedValue([{ instances: false, capabilities: false }]);
    await expect(assertDatabaseBackfilled()).resolves.toBeUndefined();
    const sql = db.$queryRaw.mock.calls[0]?.[0];
    expect(Array.isArray(sql) ? sql.join("") : "").toContain('"runGeneration" < 1');
    for (const column of ["capabilityMetadata", "nativeCapabilities"]) {
      const query = Array.isArray(sql) ? sql.join("") : "";
      expect(query).toContain(`"${column}" ? 'completions'`);
      expect(query).toContain(`"${column}" -> 'surfaces' ? 'openaiCompletions'`);
    }
  });

  it.each([
    { instances: true, capabilities: false },
    { instances: false, capabilities: true },
    { instances: true, capabilities: true },
  ])("refuses unconverted rows (%j) with deployment instructions", async (result) => {
    db.$queryRaw.mockResolvedValue([result]);
    await expect(assertDatabaseBackfilled()).rejects.toThrow(
      "Database has rows from WS Model Proxy 0.4.x that the 1.0 schema backfill has not converted. Deploy once with APPLY_SCHEMA=safe (see UPGRADING.md).",
    );
  });

  it("names the deploy step when the schema was never created", async () => {
    db.$queryRaw.mockRejectedValue(
      Object.assign(new Error('relation "runtime_instance" does not exist'), {
        meta: { code: "42P01" },
      }),
    );
    await expect(assertDatabaseBackfilled()).rejects.toThrow(
      "The database has no WS Model Proxy schema yet. Deploy once with APPLY_SCHEMA=safe to create it (see UPGRADING.md).",
    );
  });

  it("propagates query failures instead of accepting traffic", async () => {
    db.$queryRaw.mockRejectedValue(new Error("database unavailable"));
    await expect(assertDatabaseBackfilled()).rejects.toThrow("database unavailable");
  });
});
