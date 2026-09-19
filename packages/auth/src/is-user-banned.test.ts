import { admin } from "better-auth/plugins/admin";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isUserBanned } from "./is-user-banned";

/** Full decision matrix (MCP plan Phase 4 item 3; F5 equality flip, pass 2). */
describe("isUserBanned — Better Auth admin ban semantics", () => {
  const NOW = new Date("2026-01-15T12:00:00Z");

  it("no ban fields at all → not banned", () => {
    expect(isUserBanned({}, NOW)).toBe(false);
    expect(isUserBanned({ banned: null, banExpires: null }, NOW)).toBe(false);
  });

  it("banned: false (even with a future expiry left over) → not banned", () => {
    expect(isUserBanned({ banned: false }, NOW)).toBe(false);
    expect(isUserBanned({ banned: false, banExpires: new Date("2026-06-01T00:00:00Z") }, NOW)).toBe(
      false,
    );
    expect(isUserBanned({ banned: null, banExpires: new Date("2026-06-01T00:00:00Z") }, NOW)).toBe(
      false,
    );
  });

  it("indefinite ban (banned: true, no expiry) → banned", () => {
    expect(isUserBanned({ banned: true, banExpires: null }, NOW)).toBe(true);
    expect(isUserBanned({ banned: true, banExpires: undefined }, NOW)).toBe(true);
    expect(isUserBanned({ banned: true }, NOW)).toBe(true);
  });

  it("future-expiry temporary ban → banned", () => {
    expect(isUserBanned({ banned: true, banExpires: new Date("2026-01-15T12:00:01Z") }, NOW)).toBe(
      true,
    );
    expect(isUserBanned({ banned: true, banExpires: new Date("2027-01-01T00:00:00Z") }, NOW)).toBe(
      true,
    );
  });

  it("F5 boundary matrix (installed admin expires only when banExpires < now)", () => {
    // now − 1ms: strictly in the past → expired, NOT banned.
    expect(isUserBanned({ banned: true, banExpires: new Date(NOW.getTime() - 1) }, NOW)).toBe(
      false,
    );
    // EXACTLY now: still banned (upstream: banExpires < Date.now() is the
    // ONLY expiry condition — equality stays banned).
    expect(isUserBanned({ banned: true, banExpires: NOW }, NOW)).toBe(true);
    // now + 1ms: future → banned.
    expect(isUserBanned({ banned: true, banExpires: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
  });

  it("past-expiry temporary ban → expired, not banned", () => {
    expect(isUserBanned({ banned: true, banExpires: new Date("2026-01-15T11:59:59Z") }, NOW)).toBe(
      false,
    );
    expect(isUserBanned({ banned: true, banExpires: new Date("2020-01-01T00:00:00Z") }, NOW)).toBe(
      false,
    );
  });
});

/**
 * INSTALLED-ADMIN-HOOK PARITY (F5): drive the REAL better-auth admin
 * session-create hook with a frozen clock and assert its decision at the
 * boundary matches isUserBanned for every case.
 */
describe("isUserBanned — installed admin-hook parity (frozen clock)", () => {
  const NOW_MS = Date.parse("2026-01-15T12:00:00Z");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["banExpires < now (expired)", new Date(NOW_MS - 1), false],
    ["banExpires === now (boundary)", new Date(NOW_MS), true],
    ["banExpires > now (active)", new Date(NOW_MS + 1), true],
    ["no expiry (indefinite)", null, true],
  ])("%s: upstream decision matches isUserBanned", async (_label, banExpires, expectedBanned) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    // Minimal full rows for the TYPED internalAdapter surface (id/timestamps/
    // email/name are required by @better-auth/core's User; ban fields ride
    // along as the additional record keys the hook reads).
    const baseRow = {
      id: "probe-user",
      createdAt: new Date(NOW_MS),
      updatedAt: new Date(NOW_MS),
      email: "probe@example.com",
      emailVerified: true,
      name: "Probe User",
      image: null,
    };
    const foundRow = { ...baseRow, banned: true, banExpires };
    const user = { banned: true, banExpires };

    let upstreamBanned = false;
    try {
      const hook = admin().init().options.databaseHooks.session.create.before;
      type HookCtx = Parameters<typeof hook>[1];
      // Only `userId` is read from the session row; the full row shape
      // satisfies the typed hook signature. The ctx is a PARTIAL mock (two
      // adapter methods on a much larger runtime context) — one precise
      // cast to the hook's own ctx parameter type, never `any`.
      await hook(
        {
          id: "probe-session",
          createdAt: new Date(NOW_MS),
          updatedAt: new Date(NOW_MS),
          userId: "probe-user",
          expiresAt: new Date(NOW_MS + 3_600_000),
          token: "probe-token",
          ipAddress: null,
          userAgent: null,
        },
        {
          context: {
            internalAdapter: {
              findUserById: async () => foundRow,
              // Upstream's expired-ban branch UNBANS via updateUser before
              // admitting — provide the adapter method so the expired case
              // resolves "allowed" instead of throwing on a missing fn.
              updateUser: async () => baseRow,
            },
          },
        } as HookCtx,
      );
    } catch {
      upstreamBanned = true;
    }

    expect(upstreamBanned).toBe(expectedBanned);
    expect(isUserBanned(user, new Date(NOW_MS))).toBe(expectedBanned);
  });
});
