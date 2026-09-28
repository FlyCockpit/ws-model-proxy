// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { providers?: string }) =>
      options?.providers ? `${key}: ${options.providers}` : key,
  }),
}));

const { PoolFallbackBadge, ownerFallbackRoutes } = await import("./pool-fallback-badge");

afterEach(cleanup);

const LABEL = "dashboard:pools.fallbackBadge.label";

describe("PoolFallbackBadge", () => {
  it("shows a static local-only chip when no external route exists", () => {
    render(<PoolFallbackBadge routes={[]} providers={["ignored"]} />);
    expect(screen.getByText("dashboard:pools.fallbackBadge.local")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it("opens the details on tap or click, listing the viewer's routes and providers", async () => {
    render(
      <PoolFallbackBadge routes={["pool-fallback"]} providers={["openrouter", "anthropic"]} />,
    );
    const badge = screen.getByRole("button", { name: LABEL });
    expect(badge.getAttribute("type")).toBe("button");
    expect(screen.queryByText("dashboard:pools.fallbackBadge.intro")).toBeNull();
    fireEvent.click(badge);
    expect(await screen.findByText("dashboard:pools.fallbackBadge.intro")).toBeTruthy();
    expect(
      screen.getByText("dashboard:pools.fallbackBadge.routePoolFallback: openrouter, anthropic"),
    ).toBeTruthy();
    expect(screen.queryByText("dashboard:pools.fallbackBadge.routeOwnKey")).toBeNull();
    expect(screen.getByText("dashboard:pools.fallbackBadge.consent")).toBeTruthy();
  });

  it("opens from the keyboard", async () => {
    const user = userEvent.setup();
    render(<PoolFallbackBadge routes={["own-key"]} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: LABEL }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText("dashboard:pools.fallbackBadge.routeOwnKey")).toBeTruthy();
    expect(screen.queryByText(/routePoolFallback/)).toBeNull();
  });

  it("names no provider when the viewer may not see any", async () => {
    render(<PoolFallbackBadge routes={["pool-fallback", "own-key"]} providers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    expect(
      await screen.findByText("dashboard:pools.fallbackBadge.routePoolFallbackUnnamed"),
    ).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackBadge.routeOwnKey")).toBeTruthy();
  });

  it("gives the 20px chip a 44px hit area", () => {
    render(<PoolFallbackBadge routes={["pool-fallback"]} />);
    const badge = screen.getByRole("button", { name: LABEL });
    // h-5 (20px) plus after:-inset-y-3 (12px above and below) = 44px.
    expect(badge.className).toContain("h-5");
    expect(badge.className).toContain("after:-inset-y-3");
    expect(badge.className).toContain("after:absolute");
  });

  it("renders a static chip inside other controls", () => {
    render(<PoolFallbackBadge routes={["pool-fallback"]} interactive={false} />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("derives owner routes from availability", () => {
    expect(ownerFallbackRoutes(true)).toEqual(["pool-fallback"]);
    expect(ownerFallbackRoutes(false)).toEqual([]);
  });
});
