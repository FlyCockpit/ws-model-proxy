import { isAPIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(
    async (_args: unknown): Promise<{ deletionRequestedAt: Date | null } | null> => null,
  ),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: { user: { findUnique } } }));

const {
  ADMIN_USER_RESTORE_PATHS,
  isSessionRefusedForDeletingUser,
  mapSessionRefusalToForbidden,
  refuseAdminRestoreOfDeletingUser,
  refuseSessionForDeletingUser,
} = await import("./user-deletion-access-guard");

const db = { user: { findUnique } };

const marked = { deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z") };

describe("pending-deletion access guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a session for a marked user whatever the ban fields hold", async () => {
    db.user.findUnique.mockResolvedValue(marked);
    const refusal = await refuseSessionForDeletingUser({ userId: "u" }).catch((e: unknown) => e);
    expect(isAPIError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ status: "FORBIDDEN" });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u" },
      select: { deletionRequestedAt: true },
    });
  });

  it("allows a session for an unmarked or missing user", async () => {
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null });
    await expect(refuseSessionForDeletingUser({ userId: "u" })).resolves.toBeUndefined();
    db.user.findUnique.mockResolvedValue(null);
    await expect(refuseSessionForDeletingUser({ userId: "u" })).resolves.toBeUndefined();
  });

  it("refuses an impersonation session whose admin is marked or deleted (IMP-MARK)", async () => {
    const rows = new Map<string, { deletionRequestedAt: Date | null } | null>([
      ["target", { deletionRequestedAt: null }],
      ["marked-admin", marked],
      ["gone-admin", null],
      ["admin", { deletionRequestedAt: null }],
    ]);
    db.user.findUnique.mockImplementation(
      async (args: unknown) => rows.get((args as { where: { id: string } }).where.id) ?? null,
    );
    for (const impersonatedBy of ["marked-admin", "gone-admin"]) {
      await expect(
        refuseSessionForDeletingUser({ userId: "target", impersonatedBy }),
      ).rejects.toMatchObject({ status: "FORBIDDEN" });
    }
    await expect(
      refuseSessionForDeletingUser({ userId: "target", impersonatedBy: "admin" }),
    ).resolves.toBeUndefined();
    await expect(
      refuseSessionForDeletingUser({ userId: "target", impersonatedBy: null }),
    ).resolves.toBeUndefined();
  });

  it.each([...ADMIN_USER_RESTORE_PATHS])(
    "refuses %s for a marked target with CONFLICT",
    async (path) => {
      db.user.findUnique.mockResolvedValue(marked);
      await expect(
        refuseAdminRestoreOfDeletingUser({ path, body: { userId: "u" } }),
      ).rejects.toMatchObject({ status: "CONFLICT" });
    },
  );

  it("covers unban, ban-with-expiry and update-user", () => {
    for (const path of ["/admin/unban-user", "/admin/ban-user", "/admin/update-user"]) {
      expect(ADMIN_USER_RESTORE_PATHS.has(path)).toBe(true);
    }
  });

  it("ignores other routes, unmarked targets and bodies without a user id", async () => {
    db.user.findUnique.mockResolvedValue(marked);
    await expect(
      refuseAdminRestoreOfDeletingUser({ path: "/admin/remove-user", body: { userId: "u" } }),
    ).resolves.toBeUndefined();
    await expect(
      refuseAdminRestoreOfDeletingUser({ path: "/admin/unban-user", body: {} }),
    ).resolves.toBeUndefined();
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null });
    await expect(
      refuseAdminRestoreOfDeletingUser({ path: "/admin/unban-user", body: { userId: "u" } }),
    ).resolves.toBeUndefined();
  });

  it("recognizes the session trigger's SQLSTATE at any wrapping depth, nothing else", () => {
    expect(isSessionRefusedForDeletingUser({ code: "WMPD1" })).toBe(true);
    expect(isSessionRefusedForDeletingUser({ cause: { cause: { originalCode: "WMPD1" } } })).toBe(
      true,
    );
    expect(
      isSessionRefusedForDeletingUser({
        meta: { driverAdapterError: { cause: { code: "WMPD1" } } },
      }),
    ).toBe(true);
    expect(
      isSessionRefusedForDeletingUser({ code: "P0001", message: "user deletion pending" }),
    ).toBe(false);
    expect(isSessionRefusedForDeletingUser(new Error("WMPD1"))).toBe(false);
    expect(isSessionRefusedForDeletingUser(null)).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isSessionRefusedForDeletingUser(cyclic)).toBe(false);
    expect(() => mapSessionRefusalToForbidden({ code: "WMPD1" })).toThrow();
    expect(() => mapSessionRefusalToForbidden({ code: "23503" })).not.toThrow();
  });
});
