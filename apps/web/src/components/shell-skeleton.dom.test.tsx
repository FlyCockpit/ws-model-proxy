// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/en-US/nodes" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string }; matches: unknown[] }) => unknown;
  }) => select({ location: { pathname: state.pathname }, matches: [] }),
  useMatch: ({ select }: { select: (match: { routeId: string }) => unknown }) =>
    select({ routeId: "__root__" }),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AUTH_SCREEN_CLASS } from "@/components/auth/auth-card";
import { ShellSkeleton } from "./shell-skeleton";

afterEach(() => {
  cleanup();
  state.pathname = "/en-US/nodes";
});

describe("ShellSkeleton", () => {
  it("keeps the shell's landmarks: a skip link to a focusable main", () => {
    render(<ShellSkeleton />);
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.tabIndex).toBe(-1);
    expect(main.className).toContain("overflow-x-clip");
    expect(screen.getByRole("link", { name: "skipToContent" }).getAttribute("href")).toBe(
      "#main-content",
    );
    expect(main.querySelector("[data-page-skeleton]")).toBeTruthy();
    // The markers check:shell-loading measures: the header, the bottom nav, the route skeleton.
    expect(document.querySelector("[data-app-header]")).toBeTruthy();
    expect(document.querySelector("[data-bottom-nav]")).toBeTruthy();
    expect(main.querySelector("[data-route-skeleton]")).toBeTruthy();
    // The header's logo is on screen from the first frame (the same AppNameLink), so it never pops in.
    const logo = document.querySelector("[data-app-header] a > img");
    expect(logo?.getAttribute("src")).toBe("/pwa-32x32.png");
    expect(logo?.getAttribute("width")).toBe("32");
  });

  it.each(["login", "signup", "forgot-password", "reset-password", "verify-email"])(
    "draws the auth screen skeleton for %s",
    (page) => {
      state.pathname = `/en-US/${page}`;
      render(<ShellSkeleton />);
      const main = screen.getByRole("main");
      const frame = Array.from(main.querySelectorAll("div")).find(
        (element) => element.className === AUTH_SCREEN_CLASS,
      );
      expect(frame?.querySelector(".max-w-md .space-y-4")).toBeTruthy();
      expect(main.querySelector("[data-route-skeleton]")).toBeNull();
    },
  );

  it.each(["mcp-login", "mcp-consent"])("draws the MCP page skeleton for %s", (page) => {
    state.pathname = `/en-US/${page}`;
    render(<ShellSkeleton />);
    const main = screen.getByRole("main");
    const frame = Array.from(main.querySelectorAll("div")).find((element) =>
      element.className.includes("py-10"),
    );
    expect(frame?.querySelector(".max-w-md .space-y-4")).toBeTruthy();
    expect(main.querySelector("[data-route-skeleton]")).toBeNull();
  });

  it("keeps the page skeleton for admin", () => {
    state.pathname = "/en-US/admin";
    render(<ShellSkeleton />);
    expect(screen.getByRole("main").querySelector("[data-route-skeleton]")).toBeTruthy();
  });

  it("draws the sidebar column and the bottom bar only where the loaded page has them", () => {
    const { container, unmount } = render(<ShellSkeleton />);
    expect(container.querySelector(".w-60")).toBeTruthy();
    expect(container.querySelector(".fixed.bottom-0")).toBeTruthy();
    unmount();
    state.pathname = "/en-US/login";
    const login = render(<ShellSkeleton />);
    expect(login.container.querySelector(".w-60")).toBeNull();
    expect(login.container.querySelector(".fixed.bottom-0")).toBeNull();
  });
});
