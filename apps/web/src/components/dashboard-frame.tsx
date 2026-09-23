import { Link, Outlet } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  Braces,
  Cable,
  DatabaseZap,
  Gauge,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  Network,
  PanelLeft,
  SquareTerminal,
} from "lucide-react";
import { useTranslation } from "react-i18next";

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

export function DashboardFrame({ lang }: { lang: string }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const sidebarCollapsed = useUiPreferences((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiPreferences((state) => state.toggleSidebar);
  const sidebarLabel = sidebarCollapsed
    ? t("dashboard:nav.expandSidebar")
    : t("dashboard:nav.collapseSidebar");

  return (
    <div className="container mx-auto flex h-full min-h-0 min-w-0 max-w-6xl flex-col px-4 py-4 md:flex-row md:py-8">
      <aside
        aria-label={t("dashboard:nav.ariaLabel")}
        data-dashboard-nav="sidebar"
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden overflow-x-hidden overflow-y-auto border-sidebar-border bg-sidebar md:sticky md:top-0 md:flex md:max-h-full md:shrink-0 md:flex-col md:self-start md:border-e",
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
          {dashboardSections.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ lang }}
              activeOptions={{ exact: item.exact }}
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
              className={cn(
                buttonVariants({
                  variant: "ghost",
                  size: sidebarCollapsed ? "icon-touch" : "touch",
                }),
                "text-muted-foreground",
                sidebarCollapsed ? "justify-center" : "justify-start gap-2",
              )}
              activeProps={{
                className: "bg-sidebar-accent text-sidebar-accent-foreground",
              }}
            >
              <item.icon aria-hidden="true" className="size-4" />
              {sidebarCollapsed ? (
                <span className="sr-only">{t(item.labelKey)}</span>
              ) : (
                <span className="min-w-0 truncate">{t(item.labelKey)}</span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
        <div className="mb-5 hidden shrink-0 md:block">
          <h1 className="text-xl font-semibold md:text-2xl">{t("dashboard:title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("dashboard:description")}</p>
        </div>

        {/* Horizontal-only: overflow-y-hidden clips accidental vertical overflow;
            overscroll-x-contain keeps horizontal swipes from chaining. Avoid
            touch-pan-x so vertical page scrolls can still begin on this strip. */}
        <div
          data-dashboard-nav="strip"
          className="mb-4 min-w-0 shrink-0 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar md:hidden"
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

        <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
