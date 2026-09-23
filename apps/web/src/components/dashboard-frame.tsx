import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  Braces,
  Cable,
  ChevronDown,
  DatabaseZap,
  Gauge,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  Network,
  PanelLeft,
  SquareTerminal,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardNotices } from "@/components/dashboard-notices";
import { TerminalStatusDot } from "@/components/terminal-status-dot";
import { TerminalWorkspaceProvider, useTerminalWorkspace } from "@/hooks/use-terminal-workspace";
import { useUiPreferences } from "@/stores/ui-preferences";

const dashboardSections = [
  {
    to: "/$lang/dashboard",
    labelKey: "dashboard:nav.overview",
    icon: LayoutDashboard,
    exact: true,
  },
  {
    to: "/$lang/dashboard/clis",
    labelKey: "dashboard:nav.clis",
    icon: Cable,
    exact: false,
  },
  {
    to: "/$lang/dashboard/terminals",
    labelKey: "dashboard:nav.terminals",
    icon: SquareTerminal,
    exact: false,
  },
  {
    to: "/$lang/dashboard/pools",
    labelKey: "dashboard:nav.pools",
    icon: Network,
    exact: false,
  },
  {
    to: "/$lang/dashboard/capacity",
    labelKey: "dashboard:nav.capacity",
    icon: Gauge,
    exact: false,
  },
  {
    to: "/$lang/dashboard/cli-tokens",
    labelKey: "dashboard:nav.cliTokens",
    icon: KeyRound,
    exact: false,
  },
  {
    to: "/$lang/dashboard/model-api-tokens",
    labelKey: "dashboard:nav.modelApiTokens",
    icon: Braces,
    exact: false,
  },
  {
    to: "/$lang/dashboard/chat-test",
    labelKey: "dashboard:nav.chatTest",
    icon: MessageSquareText,
    exact: false,
  },
  {
    to: "/$lang/dashboard/relay-metadata",
    labelKey: "dashboard:nav.relayMetadata",
    icon: DatabaseZap,
    exact: false,
  },
] as const;

// xterm and the terminal UI load only once a terminal exists or the Terminals
// page is opened.
const TerminalWorkspaceView = lazy(() =>
  import("@/components/terminals-page").then((module) => ({
    default: module.TerminalWorkspaceView,
  })),
);

type Section = (typeof dashboardSections)[number];

export function DashboardFrame({ lang }: { lang: string }) {
  const matchRoute = useMatchRoute();
  const onTerminals = Boolean(matchRoute({ to: "/$lang/dashboard/terminals", params: { lang } }));
  return (
    <TerminalWorkspaceProvider active={onTerminals}>
      <DashboardLayout lang={lang} onTerminals={onTerminals} />
    </TerminalWorkspaceProvider>
  );
}

function DashboardLayout({ lang, onTerminals }: { lang: string; onTerminals: boolean }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const sidebarCollapsed = useUiPreferences((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiPreferences((state) => state.toggleSidebar);
  const workspace = useTerminalWorkspace();
  // Once mounted, the workspace stays mounted (hidden) so terminals keep their
  // screens while other dashboard pages show.
  const [workspaceMounted, setWorkspaceMounted] = useState(false);
  if (!workspaceMounted && (onTerminals || workspace.tabs.length > 0)) {
    setWorkspaceMounted(true);
  }
  const sidebarLabel = sidebarCollapsed
    ? t("dashboard:nav.expandSidebar")
    : t("dashboard:nav.collapseSidebar");

  return (
    // The sidebar sits outside the centered container so it spans the full
    // height at the window's left edge. At md the content pane scrolls on its
    // own so the sidebar stays put; below md <main> keeps owning scroll.
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      <aside
        aria-label={t("dashboard:nav.ariaLabel")}
        data-dashboard-nav="sidebar"
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden overflow-x-hidden overflow-y-auto overscroll-contain border-sidebar-border bg-sidebar md:flex md:h-full md:shrink-0 md:flex-col md:border-e",
          sidebarCollapsed ? "w-16" : "w-56",
        )}
      >
        <div className={cn("flex p-2", sidebarCollapsed ? "justify-center" : "justify-end")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-pressed={sidebarCollapsed}
            aria-label={sidebarLabel}
            onClick={toggleSidebar}
          >
            <PanelLeft aria-hidden="true" />
          </Button>
        </div>
        <nav className="flex flex-col gap-1 px-2 pb-4" aria-label={t("dashboard:nav.ariaLabel")}>
          {dashboardSections.map((item) =>
            item.to === "/$lang/dashboard/terminals" ? (
              <TerminalsNavItem
                key={item.to}
                item={item}
                lang={lang}
                collapsed={sidebarCollapsed}
                onTerminals={onTerminals}
              />
            ) : (
              <SidebarLink key={item.to} item={item} lang={lang} collapsed={sidebarCollapsed} />
            ),
          )}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
        {onTerminals ? (
          <MobileNavStrip lang={lang} className="shrink-0 px-2 py-1" />
        ) : (
          <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col md:overflow-x-clip md:overflow-y-auto">
            <div className="container mx-auto flex h-full min-h-0 min-w-0 max-w-6xl flex-col px-4 py-4 md:py-8">
              <div className="mb-5 hidden shrink-0 md:block">
                <h1 className="text-xl font-semibold md:text-2xl">{t("dashboard:title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("dashboard:description")}</p>
              </div>

              <MobileNavStrip lang={lang} className="mb-4" />

              <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
                <DashboardNotices />
                <Outlet />
              </div>
            </div>
          </div>
        )}

        {workspaceMounted ? (
          <div hidden={!onTerminals} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Suspense fallback={null}>
              <TerminalWorkspaceView visible={onTerminals} />
            </Suspense>
          </div>
        ) : null}
        {/* The terminals route renders nothing; it keeps the router's match. */}
        {onTerminals ? <Outlet /> : null}
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  lang,
  collapsed,
  className,
}: {
  item: Section;
  lang: string;
  collapsed: boolean;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Link
      to={item.to}
      params={{ lang }}
      activeOptions={{ exact: item.exact }}
      aria-label={t(item.labelKey)}
      title={t(item.labelKey)}
      className={cn(
        buttonVariants({
          variant: "ghost",
          size: collapsed ? "icon-touch" : "touch",
        }),
        "text-muted-foreground",
        collapsed ? "justify-center" : "justify-start gap-2",
        className,
      )}
      activeProps={{
        className: "bg-sidebar-accent text-sidebar-accent-foreground",
      }}
    >
      <item.icon aria-hidden="true" className="size-4" />
      {collapsed ? (
        <span className="sr-only">{t(item.labelKey)}</span>
      ) : (
        <span className="min-w-0 truncate">{t(item.labelKey)}</span>
      )}
    </Link>
  );
}

/** The Terminals link, with a collapsible list of open terminals under it. */
function TerminalsNavItem({
  item,
  lang,
  collapsed,
  onTerminals,
}: {
  item: Section;
  lang: string;
  collapsed: boolean;
  onTerminals: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const tabs = workspace.tabs;

  if (collapsed) {
    return (
      <div className="relative flex justify-center">
        <SidebarLink item={item} lang={lang} collapsed />
        {tabs.length > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1 end-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
          >
            {tabs.length}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center">
        <SidebarLink item={item} lang={lang} collapsed={false} className="min-w-0 flex-1" />
        {tabs.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            // Ghost buttons shade while expanded (for menus); a disclosure should not.
            className="shrink-0 text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground"
            aria-expanded={expanded}
            aria-controls="dashboard-nav-terminals"
            aria-label={
              expanded ? t("dashboard:nav.hideTerminals") : t("dashboard:nav.showTerminals")
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 transition-transform", expanded ? "rotate-0" : "-rotate-90")}
            />
          </Button>
        ) : null}
      </div>
      {tabs.length > 0 && expanded ? (
        <ul
          id="dashboard-nav-terminals"
          aria-label={t("dashboard:nav.openTerminals")}
          className="ms-4 flex min-w-0 flex-col gap-0.5 border-s border-sidebar-border ps-2 pt-0.5"
        >
          {tabs.map((tab) => {
            const current = onTerminals && tab.localId === workspace.activeLocalId;
            return (
              <li key={tab.localId} className="min-w-0">
                {/* A button, not a Link: every terminal shares one URL, and
                    Link marks each one matching it aria-current. */}
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    workspace.selectTab(tab.localId);
                    void navigate({ to: "/$lang/dashboard/terminals", params: { lang } });
                  }}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "touch" }),
                    "w-full justify-start gap-2 text-muted-foreground",
                    current && "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                >
                  <TerminalStatusDot tab={tab} />
                  <span className="min-w-0 truncate">{workspace.tabLabel(tab)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Below md: a horizontal strip of section links in place of the sidebar. */
function MobileNavStrip({ lang, className }: { lang: string; className?: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    // Horizontal-only: overflow-y-hidden clips accidental vertical overflow;
    // overscroll-x-contain keeps horizontal swipes from chaining. Avoid
    // touch-pan-x so vertical page scrolls can still begin on this strip.
    <div
      data-dashboard-nav="strip"
      className={cn(
        "min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar md:hidden",
        className,
      )}
    >
      <nav className="flex w-max items-center gap-1" aria-label={t("dashboard:nav.ariaLabel")}>
        {dashboardSections.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ lang }}
            activeOptions={{ exact: item.exact }}
            className={cn(
              buttonVariants({ variant: "ghost", size: "touch" }),
              "shrink-0 justify-start gap-2 text-muted-foreground",
            )}
            activeProps={{
              className: "bg-muted text-foreground",
            }}
          >
            <item.icon aria-hidden="true" className="size-4" />
            {t(item.labelKey)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
