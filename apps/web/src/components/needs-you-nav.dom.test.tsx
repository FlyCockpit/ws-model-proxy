// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A loaded runner can take longer than the 1 s default to render the shell.
configure({ asyncUtilTimeout: 5_000 });

/** The Needs-you badge (spec §7.1, §7.4): the sidebar's Terminals item and BottomNav's More. */

const state = vi.hoisted(() => ({
  count: 0,
  signedIn: true,
  calls: 0,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useParams: () => ({ lang: "en-US" }),
    Outlet: () => null,
    Link: ({
      children,
      className,
      to,
      onClick,
      ...rest
    }: {
      children: ReactNode;
      className?: string;
      to: string;
      onClick?: () => void;
      "aria-label"?: string;
      title?: string;
    }) => (
      <a
        href={to}
        className={className}
        aria-label={rest["aria-label"]}
        title={rest.title}
        onClick={onClick}
      >
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      session: state.signedIn ? { user: { id: "owner", role: "user" } } : null,
    },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    activity: {
      needsYou: {
        count: {
          queryOptions: () => ({
            queryKey: ["activity", "needsYou", "count"],
            queryFn: async () => {
              state.calls += 1;
              return { count: state.count };
            },
          }),
        },
      },
    },
  },
}));

import { useUiPreferences } from "@/stores/ui-preferences";
import { AppFrame } from "./app-frame";
import BottomNav from "./bottom-nav";

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  state.count = 0;
  state.signedIn = true;
  state.calls = 0;
  useUiPreferences.setState({ sidebarCollapsed: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function terminalsLink() {
  const link = document.querySelector('[data-app-nav="sidebar"] a[href="/$lang/terminals"]');
  if (!link) throw new Error("no Terminals link");
  return link as HTMLAnchorElement;
}

describe("sidebar", () => {
  it("shows the count on Terminals, with the count in its accessible name", async () => {
    state.count = 3;
    mount(<AppFrame lang="en-US" />);
    await waitFor(() => expect(terminalsLink().textContent).toContain("3"));
    expect(terminalsLink().getAttribute("aria-label")).toBe(
      "nav:items.terminals, nav:needsYou.badge:3",
    );
    // Only Terminals carries it.
    expect(document.querySelectorAll("[data-needs-you-badge]")).toHaveLength(1);
    expect(document.querySelector('a[href="/$lang/overview"]')?.getAttribute("aria-label")).toBe(
      "nav:items.overview",
    );
  });

  it("keeps the badge when the sidebar is collapsed, capped at 99+", async () => {
    state.count = 150;
    useUiPreferences.setState({ sidebarCollapsed: true });
    mount(<AppFrame lang="en-US" />);
    await waitFor(() => expect(terminalsLink().textContent).toContain("99+"));
    expect(terminalsLink().getAttribute("aria-label")).toBe(
      "nav:items.terminals, nav:needsYou.badge:150",
    );
  });

  it("shows no badge when nothing needs you", async () => {
    mount(<AppFrame lang="en-US" />);
    await waitFor(() => expect(state.calls).toBe(1));
    expect(document.querySelector("[data-needs-you-badge]")).toBeNull();
    expect(terminalsLink().getAttribute("aria-label")).toBe("nav:items.terminals");
  });

  it("rechecks on an interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(<AppFrame lang="en-US" />);
    await waitFor(() => expect(state.calls).toBe(1));
    state.count = 2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => expect(terminalsLink().textContent).toContain("2"));
  });
});

describe("BottomNav", () => {
  it("puts the count on More and on Terminals inside it", async () => {
    state.count = 4;
    mount(<BottomNav />);
    // Plain queries: role queries are slow in jsdom on a loaded runner.
    const more = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-label="items.more, needsYou.badge:4"]',
      );
      if (!button) throw new Error("no badge on More yet");
      return button;
    });
    expect(more.textContent).toContain("4");
    fireEvent.click(more);
    const terminals = await waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>(
        'a[aria-label="items.terminals, needsYou.badge:4"]',
      );
      if (!link) throw new Error("no Terminals link yet");
      return link;
    });
    expect(terminals.getAttribute("href")).toBe("/$lang/terminals");
  });

  it("does not ask when signed out", async () => {
    state.signedIn = false;
    mount(<BottomNav />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.calls).toBe(0);
    expect(document.querySelector("[data-needs-you-badge]")).toBeNull();
  });
});
