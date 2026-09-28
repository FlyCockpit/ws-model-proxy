// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("opens on keyboard focus alone and keeps focus on the badge", async () => {
    const user = userEvent.setup();
    render(<PoolFallbackBadge routes={["own-key"]} />);
    await user.tab();
    const badge = screen.getByRole("button", { name: LABEL });
    expect(document.activeElement).toBe(badge);
    expect(await screen.findByText("dashboard:pools.fallbackBadge.routeOwnKey")).toBeTruthy();
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(badge);
    expect(screen.queryByText(/routePoolFallback/)).toBeNull();
  });

  it("closes on Escape without reopening from the returned focus", async () => {
    const user = userEvent.setup();
    render(<PoolFallbackBadge routes={["own-key"]} />);
    await user.tab();
    const badge = screen.getByRole("button", { name: LABEL });
    await screen.findByText("dashboard:pools.fallbackBadge.routeOwnKey");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("false"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    // Enter still toggles it from the keyboard.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
  });

  it("does not reopen when Escape returns focus from inside the hint", async () => {
    const user = userEvent.setup();
    render(<PoolFallbackBadge routes={["own-key"]} />);
    const badge = screen.getByRole("button", { name: LABEL });
    await user.tab();
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("false"));
    // Enter opens it with focus inside the hint; Escape hands focus back.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("dialog"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(badge));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(badge.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves focus where the user moved it when the hint closes", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PoolFallbackBadge routes={["own-key"]} />
        <input aria-label="composer" />
      </>,
    );
    const badge = screen.getByRole("button", { name: LABEL });
    await user.keyboard("{Tab}{Escape}{Enter}");
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("dialog"));
    const input = screen.getByRole("textbox", { name: "composer" });
    // Focus moves on while the hint is still open (as a tap on another field
    // does in a browser, where the exit animation delays the close).
    input.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("false"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(input);
  });

  it("describes the hint to assistive technology while focus stays on the badge", () => {
    render(<PoolFallbackBadge routes={["pool-fallback", "own-key"]} providers={["openrouter"]} />);
    const badge = screen.getByRole("button", { name: LABEL });
    const description = document.getElementById(badge.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain("dashboard:pools.fallbackBadge.intro");
    expect(description?.textContent).toContain(
      "dashboard:pools.fallbackBadge.routePoolFallback: openrouter",
    );
    expect(description?.textContent).toContain("dashboard:pools.fallbackBadge.routeOwnKey");
    expect(description?.textContent).toContain("dashboard:pools.fallbackBadge.consent");
  });

  it("reopens on focus after tabbing away and back", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PoolFallbackBadge routes={["own-key"]} />
        <button type="button">next</button>
      </>,
    );
    await user.tab();
    const badge = screen.getByRole("button", { name: LABEL });
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("false"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "next" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(badge);
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
  });

  it("opens once on a pointer press instead of focus-opening and click-closing", async () => {
    const user = userEvent.setup();
    render(<PoolFallbackBadge routes={["own-key"]} />);
    const badge = screen.getByRole("button", { name: LABEL });
    await user.click(badge);
    await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByText("dashboard:pools.fallbackBadge.routeOwnKey")).toBeTruthy();
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
