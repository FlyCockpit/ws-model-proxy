// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/en-US/nodes" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
