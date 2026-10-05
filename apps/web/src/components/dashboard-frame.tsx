import { Link, Outlet, useMatches, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@ws-model-proxy/ui/components/sheet";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  Braces,
  Cable,
  ChevronDown,
  Cpu,
  DatabaseZap,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Network,
  PanelLeft,
  Rocket,
  ServerCog,
  SquareTerminal,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentRequestsBadge } from "@/components/agent-requests-badge";
import { AgentRequestsNotice } from "@/components/agent-requests-notice";
import {
  DeploymentNeedsBadge,
  DeploymentOperatorNotice,
} from "@/components/deployment-operator-notice";
import { TerminalStatusDot } from "@/components/terminal-status-dot";
import { useDeploymentOperatorNeeds } from "@/hooks/use-deployment-operator-needs";
import { usePendingAgentRequests } from "@/hooks/use-pending-agent-requests";
import { TerminalWorkspaceProvider, useTerminalWorkspace } from "@/hooks/use-terminal-workspace";
import { useUiPreferences } from "@/stores/ui-preferences";

type DashboardRoute =
  | "/$lang/dashboard"
  | "/$lang/dashboard/clis"
  | "/$lang/dashboard/runtimes"
  | "/$lang/dashboard/deployments"
  | "/$lang/dashboard/pools"
  | "/$lang/dashboard/cloud-providers"
  | "/$lang/dashboard/api-tokens"
  | "/$lang/dashboard/cli-tokens"
  | "/$lang/dashboard/chat-test"
  | "/$lang/dashboard/terminals"
  | "/$lang/dashboard/request-log";
type Section = { to: DashboardRoute; labelKey: string; icon: LucideIcon; exact: boolean };
type NavGroup = { id: string; labelKey?: string; sections: readonly Section[] };

const overview: Section = {
  to: "/$lang/dashboard",
  labelKey: "dashboard:nav.overview",
  icon: LayoutDashboard,
  exact: true,
};
const DEPLOYMENTS_ROUTE = "/$lang/dashboard/deployments";
const terminals: Section = {
  to: "/$lang/dashboard/terminals",
  labelKey: "dashboard:nav.terminals",
  icon: SquareTerminal,
  exact: false,
};

/** Sections in setup order: connect hardware, route models, hand out access, then tools. */
const dashboardNav: readonly NavGroup[] = [
  { id: "overview", sections: [overview] },
  {
    id: "hardware",
    labelKey: "dashboard:nav.groups.hardware",
    sections: [
      { to: "/$lang/dashboard/clis", labelKey: "dashboard:nav.clis", icon: Cable, exact: false },
      {
        to: "/$lang/dashboard/runtimes",
        labelKey: "dashboard:nav.runtimes",
        icon: Cpu,
        exact: false,
      },
      {
        to: "/$lang/dashboard/deployments",
        labelKey: "dashboard:nav.deployments",
        icon: Rocket,
        exact: false,
      },
    ],
  },
  {
    id: "routing",
    labelKey: "dashboard:nav.groups.routing",
    sections: [
      {
        to: "/$lang/dashboard/pools",
        labelKey: "dashboard:nav.pools",
        icon: Network,
        exact: false,
      },
      {
        to: "/$lang/dashboard/cloud-providers",
        labelKey: "dashboard:nav.cloudProviders",
        icon: ServerCog,
        exact: false,
      },
    ],
  },
  {
    id: "access",
    labelKey: "dashboard:nav.groups.access",
    sections: [
      {
        to: "/$lang/dashboard/api-tokens",
        labelKey: "dashboard:nav.apiTokens",
        icon: Braces,
        exact: false,
      },
      {
        to: "/$lang/dashboard/cli-tokens",
        labelKey: "dashboard:nav.cliTokens",
        icon: KeyRound,
        exact: false,
      },
    ],
  },
  {
    id: "tools",
    labelKey: "dashboard:nav.groups.tools",
    sections: [
      {
        to: "/$lang/dashboard/chat-test",
        labelKey: "dashboard:nav.chatTest",
        icon: MessageSquareText,
        exact: false,
      },
      terminals,
      {
        to: "/$lang/dashboard/request-log",
        labelKey: "dashboard:nav.requestLog",
        icon: DatabaseZap,
        exact: false,
      },
    ],
  },
];
const dashboardSections = dashboardNav.flatMap((group) => group.sections);

// xterm and the terminal UI load only once a terminal exists or the Terminals
// page is opened.
const TerminalWorkspaceView = lazy(() =>
  import("@/components/terminals-page").then((module) => ({
    default: module.TerminalWorkspaceView,
  })),
);

export type DashboardLayoutMode = "padded" | "fill";

/**
 * The deepest matched route that declares `staticData.dashboardLayout` wins.
 * Routes without the flag render inside the padded, centered container.
 */
export function resolveDashboardLayout(
  matches: readonly { staticData?: { dashboardLayout?: DashboardLayoutMode } }[],
): DashboardLayoutMode {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const layout = matches[index]?.staticData?.dashboardLayout;
    if (layout) return layout;
  }
  return "padded";
}

export function DashboardFrame({ lang }: { lang: string }) {
  const matchRoute = useMatchRoute();
  const layout = useMatches({ select: resolveDashboardLayout });
  // Terminal-specific behavior only (keep-alive workspace, provider activation);
  // the page geometry comes from the route's declared layout.
  const onTerminals = Boolean(matchRoute({ to: "/$lang/dashboard/terminals", params: { lang } }));
  return (
    <TerminalWorkspaceProvider active={onTerminals}>
      <DashboardLayout lang={lang} layout={layout} onTerminals={onTerminals} />
    </TerminalWorkspaceProvider>
  );
}

function DashboardLayout({
  lang,
  layout,
  onTerminals,
}: {
  lang: string;
  layout: DashboardLayoutMode;
  onTerminals: boolean;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const sidebarCollapsed = useUiPreferences((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiPreferences((state) => state.toggleSidebar);
  const workspace = useTerminalWorkspace();
  const deploymentNeeds = useDeploymentOperatorNeeds();
  const matchDeployments = useMatchRoute();
  const onDeployments = Boolean(
    matchDeployments({ to: DEPLOYMENTS_ROUTE, params: { lang }, fuzzy: true }),
  );
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
    // height at the window's left edge. <main> owns page scroll. On padded
    // routes the sidebar sticks to the main scrollport; fill routes keep a
    // viewport-tall frame so terminals and chat can fill it.
    <div
      className={cn(
        "flex min-w-0 flex-col md:flex-row",
        layout === "fill" ? "h-full min-h-0" : "min-h-full",
      )}
    >
      <aside
        aria-label={t("dashboard:nav.ariaLabel")}
        data-dashboard-nav="sidebar"
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden overflow-x-hidden overflow-y-auto overscroll-contain border-sidebar-border bg-sidebar md:flex md:shrink-0 md:flex-col md:border-e",
          layout === "fill"
            ? "md:h-full"
            : "md:sticky md:top-0 md:h-[100cqh] md:max-h-[100cqh] md:self-start",
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
          {dashboardNav.map((group) => {
            const labelKey = group.labelKey;
            return (
              <div
                key={group.id}
                role="group"
                aria-label={labelKey ? t(labelKey) : undefined}
                className="flex flex-col gap-1"
              >
                {labelKey ? (
                  sidebarCollapsed ? (
                    <div aria-hidden="true" className="mx-2 my-1 border-t border-sidebar-border" />
                  ) : (
                    <p
                      aria-hidden="true"
                      className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {t(labelKey)}
                    </p>
                  )
                ) : null}
                {group.sections.map((item) =>
                  item.to === terminals.to ? (
                    <TerminalsNavItem
                      key={item.to}
                      item={item}
                      lang={lang}
                      collapsed={sidebarCollapsed}
                      onTerminals={onTerminals}
                    />
                  ) : (
                    <SidebarLink
                      key={item.to}
                      item={item}
                      lang={lang}
                      collapsed={sidebarCollapsed}
                      needs={item.to === DEPLOYMENTS_ROUTE ? deploymentNeeds.count : 0}
                    />
                  ),
                )}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
        {layout === "fill" ? (
          <>
            <MobileSectionMenu lang={lang} className="shrink-0 px-2 py-1" />
            {/* Keep agent requests visible above fill routes. */}
            <div data-agent-requests="fill" className="shrink-0 px-2 pt-2 empty:hidden md:px-4">
              {onTerminals ? null : <AgentRequestsNotice lang={lang} />}
              {onTerminals || onDeployments ? null : <DeploymentOperatorNotice lang={lang} />}
            </div>
            {/* The terminals route renders nothing; the workspace below fills instead. */}
            <div
              data-dashboard-layout="fill"
              className={cn("flex min-h-0 min-w-0 flex-col", !onTerminals && "flex-1")}
            >
              <Outlet />
            </div>
          </>
        ) : (
          <div
            data-dashboard-layout="padded"
            className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col"
          >
            <div className="container mx-auto flex min-h-0 min-w-0 max-w-6xl flex-col px-4 py-4 md:py-6">
              <MobileSectionMenu lang={lang} className="mb-4" />

              <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
                <AgentRequestsNotice lang={lang} />
                {onDeployments ? null : <DeploymentOperatorNotice lang={lang} />}
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
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  lang,
  collapsed,
  className,
  badge = 0,
  needs = 0,
}: {
  item: Section;
  lang: string;
  collapsed: boolean;
  className?: string;
  /** Agent requests waiting (Terminals only). */
  badge?: number;
  /** Deployments waiting for the user (Deployments only). */
  needs?: number;
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
        collapsed ? "relative justify-center" : "justify-start gap-2",
        className,
      )}
      activeProps={{
        className: "bg-sidebar-accent text-sidebar-accent-foreground",
      }}
    >
      <item.icon aria-hidden="true" className="size-4" />
      {collapsed ? (
        <>
          <span className="sr-only">{t(item.labelKey)}</span>
          <DeploymentNeedsBadge
            count={needs}
            className="pointer-events-none absolute bottom-1 end-1"
          />
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{t(item.labelKey)}</span>
          <AgentRequestsBadge count={badge} className="ms-auto" />
          <DeploymentNeedsBadge count={needs} className="ms-auto" />
        </>
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
  const agentRequests = usePendingAgentRequests();

  if (collapsed) {
    return (
      <div className="relative flex justify-center">
        <SidebarLink item={item} lang={lang} collapsed />
        <AgentRequestsBadge
          count={agentRequests.count}
          className="pointer-events-none absolute bottom-1 end-1"
        />
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
        <SidebarLink
          item={item}
          lang={lang}
          collapsed={false}
          className="min-w-0 flex-1"
          badge={agentRequests.count}
        />
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

/**
 * Below md: one button naming the current section opens every section, grouped, in a sheet.
 * The app's BottomNav stays the only persistent mobile navigation bar.
 */
function MobileSectionMenu({ lang, className }: { lang: string; className?: string }) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  const matchRoute = useMatchRoute();
  const agentRequests = usePendingAgentRequests();
  const deploymentNeeds = useDeploymentOperatorNeeds();
  const current =
    dashboardSections.find((section) =>
      matchRoute({ to: section.to, params: { lang }, fuzzy: !section.exact }),
    ) ?? overview;
  return (
    <div data-dashboard-nav="mobile" className={cn("min-w-0 md:hidden", className)}>
      <Sheet open={open} onOpenChange={setOpen}>
        <Button
          type="button"
          variant="outline"
          size="touch"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="w-full min-w-0 justify-start gap-2"
          onClick={() => setOpen(true)}
        >
          <current.icon aria-hidden="true" className="size-4" />
          <span className="min-w-0 truncate">{t(current.labelKey)}</span>
          <span className="sr-only">{t("dashboard:nav.openSections")}</span>
          <AgentRequestsBadge count={agentRequests.count} className="ms-auto" />
          <DeploymentNeedsBadge
            count={deploymentNeeds.count}
            className={agentRequests.count > 0 ? "" : "ms-auto"}
          />
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4",
              agentRequests.count > 0 || deploymentNeeds.count > 0 ? "" : "ms-auto",
            )}
          />
        </Button>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-x-hidden overflow-y-auto"
          style={{ paddingBottom: "var(--safe-area-bottom)" }}
        >
          <SheetHeader>
            <SheetTitle>{t("dashboard:nav.ariaLabel")}</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-1 px-4 pb-4" aria-label={t("dashboard:nav.ariaLabel")}>
            {dashboardNav.map((group) => {
              const labelKey = group.labelKey;
              return (
                <div
                  key={group.id}
                  role="group"
                  aria-label={labelKey ? t(labelKey) : undefined}
                  className="flex flex-col gap-1"
                >
                  {labelKey ? (
                    <p
                      aria-hidden="true"
                      className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {t(labelKey)}
                    </p>
                  ) : null}
                  {group.sections.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      params={{ lang }}
                      activeOptions={{ exact: item.exact }}
                      onClick={() => setOpen(false)}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "touch" }),
                        "justify-start gap-2 text-muted-foreground",
                      )}
                      activeProps={{ className: "bg-muted text-foreground" }}
                    >
                      <item.icon aria-hidden="true" className="size-4" />
                      {t(item.labelKey)}
                      {item.to === terminals.to ? (
                        <AgentRequestsBadge count={agentRequests.count} className="ms-auto" />
                      ) : null}
                      {item.to === DEPLOYMENTS_ROUTE ? (
                        <DeploymentNeedsBadge count={deploymentNeeds.count} className="ms-auto" />
                      ) : null}
                    </Link>
                  ))}
                </div>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}
