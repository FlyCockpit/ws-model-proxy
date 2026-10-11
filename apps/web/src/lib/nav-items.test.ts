import { describe, expect, it } from "vitest";

import {
  getNavDirection,
  getNavItems,
  settingsNavItems,
  stripLangPrefix,
  toLangRoute,
} from "./nav-items";

const paths = (input: Parameters<typeof getNavItems>[0]) =>
  getNavItems(input).map((item) => item.path);

describe("nav-items", () => {
  it("returns no app nav items for signed-out visitors", () => {
    for (const placement of ["desktop", "mobile", "sidebar", "userMenu"] as const)
      expect(paths({ placement, isAuthenticated: false })).toEqual([]);
  });

  it("lists the 0.4.0 sections in sidebar order, admin only for admins", () => {
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "user" })).toEqual([
      "/overview",
      "/models",
      "/pools",
      "/runtimes",
      "/profiles",
      "/nodes",
      "/providers",
      "/access/api-keys",
      "/activity",
      "/terminals",
      "/settings",
    ]);
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "user, admin" })).toContain(
      "/admin",
    );
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "manager" })).not.toContain(
      "/admin",
    );
  });

  it("keeps the BottomNav to four sections (the rest is in More)", () => {
    expect(paths({ placement: "mobile", isAuthenticated: true, role: "admin" })).toEqual([
      "/overview",
      "/models",
      "/pools",
      "/runtimes",
    ]);
  });

  it("derives user-menu destinations from the shared nav model", () => {
    expect(paths({ placement: "userMenu", isAuthenticated: true, role: "user" })).toEqual([
      "/settings",
    ]);
    expect(paths({ placement: "userMenu", isAuthenticated: true, role: "admin" })).toEqual([
      "/settings",
      "/admin",
    ]);
  });

  it("builds typed locale-prefixed routes", () => {
    expect(toLangRoute("/")).toBe("/$lang");
    expect(toLangRoute("/overview")).toBe("/$lang/overview");
    expect(toLangRoute("/access/api-keys")).toBe("/$lang/access/api-keys");
  });

  it("slides by sidebar order between sections", () => {
    expect(getNavDirection("/overview", "/pools")).toBe("forward");
    expect(getNavDirection("/pools", "/overview")).toBe("back");
    expect(getNavDirection("/settings", "/settings")).toBe("none");
  });

  it("lists the settings sub-nav in visual order", () => {
    expect(settingsNavItems.map((item) => item.path)).toEqual(["/settings", "/settings/security"]);
    expect(getNavDirection("/settings", "/settings/security")).toBe("forward");
    expect(getNavDirection("/settings/security", "/settings")).toBe("back");
  });

  it("goes forward into child routes and back out of them", () => {
    expect(getNavDirection("/pools", "/pools/p1/routing")).toBe("forward");
    expect(getNavDirection("/pools/p1/routing", "/pools")).toBe("back");
    expect(getNavDirection("/overview", "/login")).toBe("forward");
  });

  it("strips the locale prefix", () => {
    expect(stripLangPrefix("/en-US/overview")).toBe("/overview");
    expect(stripLangPrefix("/en-US")).toBe("/");
    expect(stripLangPrefix("/en-US/")).toBe("/");
    expect(stripLangPrefix("/en-US/settings/security")).toBe("/settings/security");
  });
});
