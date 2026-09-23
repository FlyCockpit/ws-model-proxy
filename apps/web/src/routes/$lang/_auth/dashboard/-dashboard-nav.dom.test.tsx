// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
      onClick,
    }: {
      children: ReactNode;
      className?: string;
      to: string;
      onClick?: () => void;
    }) => (
      <a className={className} href={to} onClick={onClick}>
        {children}
      </a>
    ),
    Outlet: () => <div data-testid="dashboard-outlet" />,
    useMatchRoute: () => () => false,
    useNavigate: () => router.navigate,
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

const router = vi.hoisted(() => ({ navigate: (_options: object): void => undefined }));

const workspace = vi.hoisted(() => ({
  tabs: [] as { localId: string; phase: string; error: string | null; label: string }[],
  selectTab: (_localId: string): void => undefined,
}));

vi.mock("@/hooks/use-terminal-workspace", () => ({
  TerminalWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  useTerminalWorkspace: () => ({
    tabs: workspace.tabs,
    activeLocalId: null,
    selectTab: workspace.selectTab,
    tabLabel: (tab: { label: string }) => tab.label,
  }),
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
  workspace.tabs = [];
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

  it("lists open terminals under Terminals and selects one on click", () => {
    const selectTab = vi.fn();
    const navigate = vi.fn();
    workspace.selectTab = selectTab;
    router.navigate = navigate;
    workspace.tabs = [
      { localId: "a", phase: "live", error: null, label: "laptop" },
      { localId: "b", phase: "opening", error: null, label: "build-server" },
    ];
    renderLayout();
    const list = screen.getByRole("list", { name: "dashboard:nav.openTerminals" });
    const entries = within(list).getAllByRole("button");
    // Selection drives aria-current; nothing is selected off the Terminals page.
    expect(entries.map((entry) => entry.getAttribute("aria-current"))).toEqual([null, null]);
    fireEvent.click(within(list).getByRole("button", { name: "build-server" }));
    expect(selectTab).toHaveBeenCalledWith("b");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/$lang/dashboard/terminals" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "dashboard:nav.hideTerminals" }));
    expect(screen.queryByRole("list", { name: "dashboard:nav.openTerminals" })).toBeNull();
  });

  it("shows an open-terminal count on the collapsed sidebar", () => {
    useUiPreferences.setState({ sidebarCollapsed: true });
    workspace.tabs = [{ localId: "a", phase: "live", error: null, label: "laptop" }];
    renderLayout();
    expect(screen.queryByRole("list", { name: "dashboard:nav.openTerminals" })).toBeNull();
    expect(screen.getByRole("complementary").textContent).toContain("1");
  });
});
