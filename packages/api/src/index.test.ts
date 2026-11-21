import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "./context";
import type { ProcedureAccess } from "./contracts/procedure";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { assertAccess, isHumanCaller } from "./index";

function context(): Context {
  return {
    session: {
      user: { id: "user", role: "admin", emailVerified: true, twoFactorEnabled: false },
    } as Session,
    auth: { kind: "cookie_session", userId: "user", sessionId: "session", csrfVerified: true },
  };
}

beforeEach(() => vi.mocked(isForceTwoFactorRequired).mockResolvedValue(false));

describe("contract access after retiring procedure builders", () => {
  it.each(["session", "agent", "human", "admin", "human_admin"] satisfies ProcedureAccess[])(
    "preserves the signed-in session for %s access",
    async (access) => {
      const ctx = context();
      expect(await assertAccess(access, ctx)).toBe(ctx.session);
      expect(isHumanCaller(ctx.auth)).toBe(true);
    },
  );

  it("preserves hidden admin denial and human CSRF checks", async () => {
    const ctx = context();
    ctx.session!.user.role = "user";
    await expect(assertAccess("admin", ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    ctx.auth = {
      kind: "cookie_session",
      userId: "user",
      sessionId: "session",
      csrfVerified: false,
    };
    expect(isHumanCaller(ctx.auth)).toBe(false);
    await expect(assertAccess("human", ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves forced 2FA and identity checks", async () => {
    const ctx = context();
    vi.mocked(isForceTwoFactorRequired).mockResolvedValue(true);
    await expect(assertAccess("agent", ctx)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Two-factor authentication setup is required.",
    });
    ctx.auth = {
      kind: "cookie_session",
      userId: "other",
      sessionId: "session",
      csrfVerified: true,
    };
    await expect(assertAccess("session", ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
