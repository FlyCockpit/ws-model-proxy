import { describe, expect, it } from "vitest";

import {
  type RouteSession,
  requireAdminRoute,
  requireAnonymousOnlyRoute,
  requireDeviceAdminRoute,
  requireProtectedRoute,
} from "./route-session-access";

const session = {
  user: {
    id: "u1",
    name: "User One",
    email: "u1@example.com",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
  },
} satisfies RouteSession;

const adminSession = {
  user: {
    ...session.user,
    role: "admin",
  },
} satisfies RouteSession;

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected function to throw");
}

describe("route session access decisions", () => {
  it("allows protected routes for authenticated sessions", () => {
    expect(requireProtectedRoute({ session, lang: "en-US", href: "/en-US/dashboard" })).toBe(
      session,
    );
  });

  it("redirects anonymous protected routes to login", () => {
    const error = thrownBy(() =>
      requireProtectedRoute({ session: null, lang: "en-US", href: "/en-US/dashboard" }),
    );

    expect(error).toMatchObject({
      options: {
        to: "/$lang/login",
        params: { lang: "en-US" },
        search: { redirectTo: "/en-US/dashboard" },
      },
    });
  });

  it("redirects authenticated users away from anonymous-only routes", () => {
    const error = thrownBy(() =>
      requireAnonymousOnlyRoute({ session, lang: "en-US", redirectTo: "/en-US/dashboard" }),
    );

    expect(error).toMatchObject({
      options: {
        href: "/en-US/dashboard",
      },
    });
  });

  it("allows anonymous users on anonymous-only routes", () => {
    expect(
      requireAnonymousOnlyRoute({ session: null, lang: "en-US", redirectTo: undefined }),
    ).toBeUndefined();
  });

  it("404-hides admin routes from non-admin users", () => {
    expect(thrownBy(() => requireAdminRoute({ session }))).toEqual({ isNotFound: true });
  });

  it("allows verified admins through admin routes", () => {
    expect(requireAdminRoute({ session: adminSession })).toBe(adminSession);
  });

  it("redirects non-admin device approvers to dashboard", () => {
    const error = thrownBy(() =>
      requireDeviceAdminRoute({ session, lang: "en-US", redirectTo: "/en-US/device" }),
    );

    expect(error).toMatchObject({
      options: {
        to: "/$lang/dashboard",
        params: { lang: "en-US" },
      },
    });
  });

  it("redirects anonymous device approvers to login with the device redirect", () => {
    const error = thrownBy(() =>
      requireDeviceAdminRoute({ session: null, lang: "en-US", redirectTo: "/en-US/device" }),
    );

    expect(error).toMatchObject({
      options: {
        to: "/$lang/login",
        params: { lang: "en-US" },
        search: { redirectTo: "/en-US/device" },
      },
    });
  });
});
