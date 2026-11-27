import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
  SIGNUP_ENABLED: true,
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: {
    appSetting: { findUnique: vi.fn() },
    user: { count: vi.fn() },
  },
}));

const { SIGNUP_DISABLED_MESSAGE } = await import("./signup-policy");
const { runWithAdminInviteLocale } = await import("./admin-invite-locale");
const {
  isAdminCreateUserPath,
  refuseUnprovedUserCreation,
  resolveUserCreatePolicy,
  toUserCreatePolicyInput,
} = await import("./user-create-policy");

describe("refuseUnprovedUserCreation", () => {
  const adminCreate = { path: "/admin/create-user" };

  it("refuses /admin/create-user outside users.invite's scope (every HTTP call)", () => {
    expect(() => refuseUnprovedUserCreation({}, adminCreate)).toThrow(
      expect.objectContaining({
        body: expect.objectContaining({ code: "ADMIN_CREATE_USER_UNSUPPORTED" }),
      }),
    );
    expect(() =>
      runWithAdminInviteLocale("en-US", () => refuseUnprovedUserCreation({}, adminCreate)),
    ).not.toThrow();
    expect(() => refuseUnprovedUserCreation({}, { path: "/sign-up/email" })).not.toThrow();
  });

  it("refuses a new user the caller marked verified, on every route", () => {
    for (const context of [adminCreate, { path: "/sign-up/email" }, null]) {
      expect(() =>
        runWithAdminInviteLocale("en-US", () =>
          refuseUnprovedUserCreation({ emailVerified: true }, context),
        ),
      ).toThrow(
        expect.objectContaining({
          body: expect.objectContaining({ code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" }),
        }),
      );
    }
    expect(() =>
      runWithAdminInviteLocale("en-US", () =>
        refuseUnprovedUserCreation({ emailVerified: false }, adminCreate),
      ),
    ).not.toThrow();
  });
});

describe("isAdminCreateUserPath", () => {
  it("accepts the canonical admin create-user path after benign query/hash/slash strip", () => {
    expect(isAdminCreateUserPath("/admin/create-user")).toBe(true);
    expect(isAdminCreateUserPath("/admin/create-user/")).toBe(true);
    expect(isAdminCreateUserPath("/admin/create-user?x=1")).toBe(true);
    expect(isAdminCreateUserPath("/admin/create-user#frag")).toBe(true);
    expect(isAdminCreateUserPath("/admin/create-user/?x=1")).toBe(true);
  });

  it("fails closed for prefixed, case-variant, extra-suffix, and missing paths", () => {
    expect(isAdminCreateUserPath("/internal/admin/create-user")).toBe(false);
    expect(isAdminCreateUserPath("/api/auth/admin/create-user")).toBe(false);
    expect(isAdminCreateUserPath("/admin/createUser")).toBe(false);
    expect(isAdminCreateUserPath("/admin/create-user-extra")).toBe(false);
    expect(isAdminCreateUserPath("admin/create-user")).toBe(false);
    expect(isAdminCreateUserPath("/ADMIN/create-user")).toBe(false);
    expect(isAdminCreateUserPath("/admin/create-user//")).toBe(false);
    expect(isAdminCreateUserPath("/sign-up/email")).toBe(false);
    expect(isAdminCreateUserPath("/sign-up")).toBe(false);
    expect(isAdminCreateUserPath("/admin/list-users")).toBe(false);
    expect(isAdminCreateUserPath("/admin")).toBe(false);
    expect(isAdminCreateUserPath("")).toBe(false);
    expect(isAdminCreateUserPath("   ")).toBe(false);
    expect(isAdminCreateUserPath(undefined)).toBe(false);
    expect(isAdminCreateUserPath(null)).toBe(false);
  });
});

describe("resolveUserCreatePolicy", () => {
  it("allows public create when signup is enabled and forces role user", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: true,
        userCount: 3,
        emailConfigured: false,
        requestedRole: "admin",
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "user", emailVerified: true });
  });

  it("lets emailVerified follow the SMTP flag for public creates", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: true,
        userCount: 1,
        emailConfigured: true,
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "user" });

    expect(
      resolveUserCreatePolicy({
        signupEnabled: true,
        userCount: 1,
        emailConfigured: false,
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "user", emailVerified: true });
  });

  it("allows an authorized first user when signup is disabled", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 0,
        adminBootstrapAllowed: true,
        emailConfigured: false,
        requestedRole: "user",
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "admin", emailVerified: true });
  });

  it("rejects an unlisted production bootstrap before it can receive the admin role", () => {
    expect(() =>
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 0,
        adminBootstrapAllowed: false,
        emailConfigured: false,
        requestedRole: "admin",
        contextPath: "/sign-up/email",
      }),
    ).toThrow(SIGNUP_DISABLED_MESSAGE);
  });

  it("refuses with a coded error callers classify without reading the message", () => {
    expect(() =>
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 3,
        adminBootstrapAllowed: false,
        emailConfigured: false,
        requestedRole: undefined,
        contextPath: "/sign-up/email",
      }),
    ).toThrow(expect.objectContaining({ code: "SIGNUP_DISABLED" }));
  });

  it("fails closed when a creation path omits bootstrap authorization", () => {
    expect(() =>
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 0,
        emailConfigured: false,
        requestedRole: "admin",
        contextPath: "/sign-up/email",
      }),
    ).toThrow(SIGNUP_DISABLED_MESSAGE);
  });

  it("allows a listed production bootstrap and assigns its first user admin", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 0,
        adminBootstrapAllowed: true,
        emailConfigured: false,
        requestedRole: "user",
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "admin", emailVerified: true });
  });

  it("still assigns admin to the first user even on an admin create-user path", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 0,
        adminBootstrapAllowed: true,
        emailConfigured: true,
        requestedRole: "user",
        contextPath: "/admin/create-user",
      }),
    ).toEqual({ role: "admin" });
  });

  it("rejects public, unknown, and missing paths when signup is disabled and users exist", () => {
    const base = {
      signupEnabled: false,
      userCount: 2,
      emailConfigured: true,
    };

    for (const contextPath of [
      "/sign-up/email",
      "/unknown",
      "/internal/admin/create-user",
      "/api/auth/admin/create-user",
      "",
      undefined,
      null,
    ]) {
      expect(() =>
        resolveUserCreatePolicy({
          ...base,
          contextPath,
        }),
      ).toThrow(SIGNUP_DISABLED_MESSAGE);
    }
  });

  it("allows a public sign-up with a pending invite token when signup is disabled, as user", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 2,
        emailConfigured: true,
        inviteTokenPending: true,
        requestedRole: "admin",
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "user" });
  });

  it("a pending invite token opens no other creation path, and no token opens nothing", () => {
    for (const contextPath of ["/unknown", "/sign-in/email", "/sign-up", "", undefined, null]) {
      expect(() =>
        resolveUserCreatePolicy({
          signupEnabled: false,
          userCount: 2,
          emailConfigured: false,
          inviteTokenPending: true,
          contextPath,
        }),
      ).toThrow(SIGNUP_DISABLED_MESSAGE);
    }
    expect(() =>
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 2,
        emailConfigured: false,
        inviteTokenPending: false,
        contextPath: "/sign-up/email",
      }),
    ).toThrow(SIGNUP_DISABLED_MESSAGE);
  });

  it("allows admin create-user when signup is disabled", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 4,
        emailConfigured: false,
        requestedRole: "user",
        contextPath: "/admin/create-user",
      }),
    ).toEqual({ role: "user" });
  });

  it("preserves an admin-requested admin role", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 2,
        emailConfigured: true,
        requestedRole: "admin",
        contextPath: "/admin/create-user",
      }),
    ).toEqual({ role: "admin" });
  });

  it("defaults an admin create with no or empty role to user", () => {
    const base = {
      signupEnabled: true,
      userCount: 2,
      emailConfigured: true,
      contextPath: "/admin/create-user",
    };

    expect(resolveUserCreatePolicy({ ...base, requestedRole: undefined })).toEqual({
      role: "user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: "" })).toEqual({
      role: "user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: "   " })).toEqual({
      role: "user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: [] })).toEqual({
      role: "user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: ["", "  "] })).toEqual({
      role: "user",
    });
  });

  it("preserves comma-separated and array admin-requested roles", () => {
    const base = {
      signupEnabled: false,
      userCount: 2,
      emailConfigured: true,
      contextPath: "/admin/create-user",
    };

    expect(resolveUserCreatePolicy({ ...base, requestedRole: "admin,user" })).toEqual({
      role: "admin,user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: ["admin", "user"] })).toEqual({
      role: "admin,user",
    });
    expect(resolveUserCreatePolicy({ ...base, requestedRole: [" admin ", "user"] })).toEqual({
      role: "admin,user",
    });
  });

  it("keeps admin-created users unverified until the invite link is spent", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: false,
        userCount: 1,
        emailConfigured: true,
        requestedRole: "user",
        contextPath: "/admin/create-user",
      }),
    ).toEqual({ role: "user" });
  });

  it("does not force emailVerified true for public create when SMTP is configured", () => {
    const result = resolveUserCreatePolicy({
      signupEnabled: true,
      userCount: 1,
      emailConfigured: true,
      contextPath: "/sign-up/email",
    });
    expect(result).toEqual({ role: "user" });
    expect(result).not.toHaveProperty("emailVerified");
  });

  it("forces emailVerified true for public create when SMTP is unset", () => {
    expect(
      resolveUserCreatePolicy({
        signupEnabled: true,
        userCount: 1,
        emailConfigured: false,
        contextPath: "/sign-up/email",
      }),
    ).toEqual({ role: "user", emailVerified: true });
  });
});

describe("toUserCreatePolicyInput", () => {
  const access = {
    signupEnabled: false,
    userCount: 2,
    emailConfigured: true,
  };

  it("forwards context.path and a present user.role", () => {
    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: "admin" },
        context: { path: "/admin/create-user" },
      }),
    ).toEqual({
      ...access,
      requestedRole: "admin",
      contextPath: "/admin/create-user",
    });
  });

  it("forwards requestedRole only when the user object has a role key", () => {
    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { email: "a@example.com" },
        context: { path: "/admin/create-user" },
      }).requestedRole,
    ).toBeUndefined();

    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: undefined },
        context: { path: "/admin/create-user" },
      }).requestedRole,
    ).toBeUndefined();

    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: ["admin", "user"] },
        context: { path: "/admin/create-user" },
      }).requestedRole,
    ).toEqual(["admin", "user"]);
  });

  it("treats missing or non-string context.path as undefined", () => {
    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: "admin" },
        context: {},
      }).contextPath,
    ).toBeUndefined();

    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: "admin" },
        context: { path: 12 },
      }).contextPath,
    ).toBeUndefined();

    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: "admin" },
        context: null,
      }).contextPath,
    ).toBeUndefined();

    expect(
      toUserCreatePolicyInput({
        ...access,
        user: { role: "admin" },
      }).contextPath,
    ).toBeUndefined();
  });

  it("fails closed when signup is disabled and the hook path is missing", () => {
    expect(() =>
      resolveUserCreatePolicy(
        toUserCreatePolicyInput({
          ...access,
          user: { role: "admin" },
          context: {},
        }),
      ),
    ).toThrow(SIGNUP_DISABLED_MESSAGE);
  });

  it("lets the forwarded admin path and role through when signup is disabled", () => {
    expect(
      resolveUserCreatePolicy(
        toUserCreatePolicyInput({
          ...access,
          user: { role: "admin" },
          context: { path: "/admin/create-user" },
        }),
      ),
    ).toEqual({ role: "admin" });
  });
});
