// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUiPreferences } from "@/stores/ui-preferences";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      to,
    }: {
      children: ReactNode;
      className?: string;
      to: string;
    }) => (
      <a className={className} href={to}>
        {children}
      </a>
    ),
    Outlet: () => <div data-testid="dashboard-outlet" />,
    createFileRoute: () => (options: { component?: ComponentType }) => ({
      ...options,
      useParams: () => ({ lang: "en-US" }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      listDashboardNotices: {
        queryOptions: () => ({
          queryKey: ["dashboard-notices"],
          queryFn: async () => [],
          initialData: [],
        }),
        key: () => ["dashboard-notices"],
      },
      dismissDashboardNotice: {
        mutationOptions: () => ({ mutationFn: async () => ({ dismissed: true }) }),
      },
    },
  },
}));

import { DashboardFrame } from "@/components/dashboard-frame";

function renderLayout() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DashboardFrame lang="en-US" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  useUiPreferences.setState({ sidebarCollapsed: false });
});

describe("dashboard sidebar", () => {
  it("shows the aside at md and hides the horizontal strip at md", () => {
    useUiPreferences.setState({ sidebarCollapsed: false });
    renderLayout();
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("md:flex");
    expect(aside.className).toContain("w-56");
    expect(aside.className).not.toContain("w-16");
    const strip = document.querySelector("[data-dashboard-nav='strip']");
    expect(strip?.className).toContain("md:hidden");
    expect(screen.getAllByRole("link", { name: "dashboard:nav.terminals" }).length).toBeGreaterThan(
      0,
    );
  });

  it("uses the icon-only width when the sidebar is collapsed", () => {
    useUiPreferences.setState({ sidebarCollapsed: true });
    renderLayout();
    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("data-collapsed")).toBe("true");
    expect(aside.className).toContain("w-16");
    expect(aside.className).not.toContain("w-56");
    expect(screen.getByRole("button", { name: "dashboard:nav.expandSidebar" })).toBeTruthy();
  });
});
