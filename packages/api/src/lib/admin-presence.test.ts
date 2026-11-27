import { DatabaseSync } from "node:sqlite";
import { isAdminRole } from "@ws-model-proxy/auth/roles";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { activeAdminUserCount } = await import("./admin-presence");
const db = prisma as unknown as { $queryRaw: MockInstance };

describe("activeAdminUserCount", () => {
  it("counts active admins with the shared token and ban-expiry rules on the supplied transaction", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const query = vi.fn().mockResolvedValue([{ count: 2 }]);
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(2);
    expect(query).toHaveBeenCalledOnce();
    const [strings, instant] = query.mock.calls[0] ?? [];
    const sql = (strings as TemplateStringsArray).join("?");
    expect(sql).toContain("count(*)::int");
    // Authorization requires a verified inbox; pending admin invites cannot save
    // the last usable administrator. Check the predicate on the actual query.
    expect(sql).toContain('AND u."emailVerified" IS TRUE');
    expect(sql).toContain("string_to_array(u.role, ',')");
    expect(sql).toContain("~* '^\\s*admin\\s*$'");
    expect(sql).toContain('u.banned IS NOT TRUE OR u."banExpires" < ?');
    expect(instant).toEqual(now);
  });

  it("executes the verification and ban predicates over verified admins and pending invites", async () => {
    // No external DB: execute the emitted WHERE clause in SQLite memory. Only
    // PostgreSQL's cast, ILIKE and token/array syntax need adapting; verification
    // and ban predicates run verbatim, rather than returning a canned count.
    using sql = new DatabaseSync(":memory:");
    sql.exec(
      'CREATE TABLE "user" (id TEXT, role TEXT, "emailVerified" INTEGER, banned INTEGER, "banExpires" INTEGER, "deletionRequestedAt" INTEGER)',
    );
    sql.function("admin_token", (role) => Number(isAdminRole(role)));
    const insert = sql.prepare('INSERT INTO "user" VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date("2026-11-26T12:00:00Z");
    insert.run("a", "admin", 1, 0, null, null);
    insert.run("b", "user, Admin", 1, 0, null, null);
    insert.run("invite", "admin", 0, 0, null, null);
    insert.run("banned", "admin", 1, 1, null, null);
    insert.run("temporary-ban", "admin", 1, 1, now.getTime() + 60_000, null);
    insert.run("expired-ban", "admin", 1, 1, now.getTime() - 1, null);
    insert.run("boundary-ban", "admin", 1, 1, now.getTime(), null);
    insert.run("deleting", "admin", 1, 0, null, 1);
    insert.run("lookalike", "superadmin", 1, 0, null, null);
    const query = vi
      .fn()
      .mockImplementation(async (strings: TemplateStringsArray, instant: Date) => {
        const statement = strings
          .join("?")
          .replace("count(*)::int", "count(*)")
          .replace("u.role ILIKE", "u.role LIKE")
          .replace(/AND EXISTS \([\s\S]*?\n {6}\)/, "AND admin_token(u.role)");
        return sql.prepare(statement).all(instant.getTime());
      });
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(3);
    sql.prepare('UPDATE "user" SET role = ? WHERE id = ?').run("user", "b");
    sql
      .prepare('UPDATE "user" SET banned = 1, "banExpires" = NULL WHERE id = ?')
      .run("expired-ban");
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(1);
    // Removing A would leave only the unverified invite; it contributes zero.
    sql.prepare('UPDATE "user" SET role = ? WHERE id = ?').run("user", "a");
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(0);
  });

  it("returns zero when there are no active admins", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
    expect(await activeAdminUserCount()).toBe(0);
  });
});
