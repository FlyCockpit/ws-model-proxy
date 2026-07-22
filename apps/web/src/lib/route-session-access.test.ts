import { describe, expect, it } from "vitest";

import {
  decideAdminRouteAccess,
  decideAnonymousOnlyRouteAccess,
  decideDeviceRouteAccess,
  decideProtectedRouteAccess,
  failedRouteSessionResolution,
  type RouteSession,
  resolvedRouteSession,
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

describe("route session access decisions", () => {
  it("allows protected routes for authenticated sessions", () => {
    expect(decideProtectedRouteAccess(resolvedRouteSession(session))).toEqual({
      kind: "allow",
      session,
    });
  });

  it("allows unverified sessions on ordinary protected routes", () => {
    const unverified = {
      user: { ...session.user, emailVerified: false },
    } satisfies RouteSession;
    expect(decideProtectedRouteAccess(resolvedRouteSession(unverified))).toEqual({
      kind: "allow",
      session: unverified,
    });
  });

  it("redirects anonymous protected routes to login", () => {
    expect(decideProtectedRouteAccess(resolvedRouteSession(null))).toEqual({
      kind: "redirect-to-login",
    });
  });

  it("surfaces session lookup failures as error decisions", () => {
    expect(decideProtectedRouteAccess(failedRouteSessionResolution())).toEqual({ kind: "error" });
    expect(decideAdminRouteAccess(failedRouteSessionResolution())).toEqual({ kind: "error" });
    expect(decideAnonymousOnlyRouteAccess(failedRouteSessionResolution())).toEqual({
      kind: "error",
    });
    expect(decideDeviceRouteAccess(failedRouteSessionResolution())).toEqual({ kind: "error" });
  });

  it("redirects authenticated users away from anonymous-only routes", () => {
    expect(decideAnonymousOnlyRouteAccess(resolvedRouteSession(session))).toEqual({
      kind: "redirect-authenticated",
      session,
    });
  });

  it("allows anonymous users on anonymous-only routes", () => {
    expect(decideAnonymousOnlyRouteAccess(resolvedRouteSession(null))).toEqual({ kind: "allow" });
  });

  it("404-hides admin routes from non-admin users", () => {
    expect(decideAdminRouteAccess(resolvedRouteSession(session))).toEqual({ kind: "not-found" });
  });

  it("404-hides admin routes from unverified admins", () => {
    const unverifiedAdmin = {
      user: { ...adminSession.user, emailVerified: false },
    } satisfies RouteSession;
    expect(decideAdminRouteAccess(resolvedRouteSession(unverifiedAdmin))).toEqual({
      kind: "not-found",
    });
  });

  it("allows verified admins through admin routes", () => {
    expect(decideAdminRouteAccess(resolvedRouteSession(adminSession))).toEqual({
      kind: "allow",
      session: adminSession,
    });
  });

  it("redirects non-admin device approvers to dashboard", () => {
    expect(decideDeviceRouteAccess(resolvedRouteSession(session))).toEqual({
      kind: "redirect-to-dashboard",
    });
  });

  it("redirects anonymous device approvers to login", () => {
    expect(decideDeviceRouteAccess(resolvedRouteSession(null))).toEqual({
      kind: "redirect-to-login",
    });
  });

  it("allows verified admins on the device route", () => {
    expect(decideDeviceRouteAccess(resolvedRouteSession(adminSession))).toEqual({
      kind: "allow",
      session: adminSession,
    });
  });
});
