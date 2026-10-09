import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPermanentParentDeletionFailure } from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

/** How a Prisma driver-adapter error carries a PostgreSQL failure. */
function adapterError(code: string, message: string) {
  const error = new Error("Invalid `prisma.$executeRaw()` invocation") as Error & {
    code: string;
    meta: unknown;
  };
  error.code = "P2010";
  error.meta = {
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: code,
        originalMessage: message,
        kind: "postgres",
        code,
        message,
      },
    },
  };
  return error;
}

/**
 * Every 55000 the hardening triggers raise, and whether a retry can clear it.
 * Permanent: the trigger refuses every DELETE of its table. Everything else is
 * a state check a concurrent writer can settle (f4-c).
 */
const PERMANENT_55000 = new Set([
  "% is append-only",
  "node_enrollment_use is append-only",
  "spend reservations cannot be deleted",
]);

function hardening55000Messages(): string[] {
  const sql = readFileSync(
    join(import.meta.dirname, "../../../db/prisma/schema-hardening.sql"),
    "utf8",
  );
  const raises = [...sql.matchAll(/RAISE\s+EXCEPTION\s+'([^']*)'[^;]*?ERRCODE\s*=\s*'55000'/g)];
  expect(raises.length).toBe(sql.match(/'55000'/g)?.length ?? 0);
  return [...new Set(raises.map((match) => match[1] ?? ""))];
}

describe("isPermanentParentDeletionFailure", () => {
  it("retries a state-check 55000 instead of archiving", () => {
    for (const message of [
      "a reservation only settles, once",
      "a finished node command stays finished",
      "instance identity is immutable",
    ])
      expect(isPermanentParentDeletionFailure(adapterError("55000", message)), message).toBe(false);
  });

  it("treats a 55000 without a message as transient", () => {
    expect(isPermanentParentDeletionFailure({ code: "55000" })).toBe(false);
    expect(isPermanentParentDeletionFailure({ cause: { originalCode: "55000" } })).toBe(false);
  });

  it("keeps a trigger that refuses every delete permanent", () => {
    expect(
      isPermanentParentDeletionFailure(adapterError("55000", "usage_ledger is append-only")),
    ).toBe(true);
    expect(
      isPermanentParentDeletionFailure(adapterError("55000", "runtime versions are immutable")),
    ).toBe(false);
    // A raw query reports the SQLSTATE and message in `meta`.
    expect(
      isPermanentParentDeletionFailure({
        code: "P2010",
        meta: { code: "55000", message: "spend reservations cannot be deleted" },
      }),
    ).toBe(true);
  });

  it("does not take a permanent message from a different SQLSTATE", () => {
    expect(
      isPermanentParentDeletionFailure(
        adapterError("40001", "spend reservations cannot be deleted"),
      ),
    ).toBe(false);
  });

  it("keeps the other permanent failures", () => {
    expect(isPermanentParentDeletionFailure(adapterError("23503", "fk"))).toBe(true);
    expect(isPermanentParentDeletionFailure(adapterError("23514", "check"))).toBe(true);
    expect(isPermanentParentDeletionFailure(adapterError("40P01", "deadlock"))).toBe(false);
  });

  it("classifies every 55000 message in schema-hardening.sql as listed", () => {
    const messages = hardening55000Messages();
    // A new refusal must be added to PERMANENT_55000 here (and to the
    // classifier) when it refuses every delete; otherwise it is transient.
    for (const permanent of PERMANENT_55000) expect(messages).toContain(permanent);
    for (const message of messages) {
      const sample = message.replace("%", "spend_settlement");
      expect(
        isPermanentParentDeletionFailure(adapterError("55000", sample)),
        `55000 "${message}"`,
      ).toBe(PERMANENT_55000.has(message));
    }
  });
});
