import { Link, Outlet } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { type AppNavItem, getNavItems, toLangRoute } from "@/lib/nav-items";
import { useUiPreferences } from "@/stores/ui-preferences";

/**
 * The signed-in app frame (spec §7.1): a desktop sidebar with every section (main sections,
 * then Terminals, Settings and Admin) next to the page. Below `md` the app's BottomNav and its
 * More sheet are the only navigation. The root shell owns safe areas and page scroll.
 */
export function AppFrame({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const { state } = useAuthSession();
  const sidebarCollapsed = useUiPreferences((prefs) => prefs.sidebarCollapsed);
  const toggleSidebar = useUiPreferences((prefs) => prefs.toggleSidebar);
  const items = getNavItems({
    placement: "sidebar",
    isAuthenticated: Boolean(state.session),
    role: state.session?.user.role,
  });
  const groups = (["main", "footer"] as const).map((id) => ({
    id,
    items: items.filter((item) => item.group === id),
  }));
  const sidebarLabel = sidebarCollapsed
    ? t("dashboard:nav.expandSidebar")
    : t("dashboard:nav.collapseSidebar");

  return (
    <div className="flex min-h-full min-w-0 flex-col md:flex-row">
      <aside
        aria-label={t("dashboard:nav.ariaLabel")}
        data-app-nav="sidebar"
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden overflow-x-hidden overflow-y-auto overscroll-contain border-sidebar-border bg-sidebar md:sticky md:top-0 md:flex md:h-[100cqh] md:max-h-[100cqh] md:shrink-0 md:flex-col md:self-start md:border-e",
          sidebarCollapsed ? "w-16" : "w-60",
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
        <nav
          className="flex flex-1 flex-col gap-1 px-2 pb-4"
          aria-label={t("dashboard:nav.ariaLabel")}
        >
          {groups.map((group) => (
            <div
              key={group.id}
              className={cn(
                "flex flex-col gap-1",
                group.id === "footer" && "mt-auto border-t pt-2",
              )}
            >
              {group.items.map((item) => (
                <SidebarLink key={item.id} item={item} lang={lang} collapsed={sidebarCollapsed} />
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
        <div className="container mx-auto flex min-h-0 min-w-0 max-w-6xl flex-col px-4 py-4 md:py-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  lang,
  collapsed,
}: {
  item: AppNavItem;
  lang: string;
  collapsed: boolean;
}) {
  const { t } = useTranslation(["nav"]);
  const label = t(`nav:${item.labelKey}`);
  return (
    <Link
      to={toLangRoute(item.path)}
      params={{ lang }}
      activeOptions={{ exact: item.exact }}
      aria-label={label}
      title={item.hintKey ? t(`nav:${item.hintKey}`) : label}
      className={cn(
        buttonVariants({ variant: "ghost", size: collapsed ? "icon-touch" : "touch" }),
        "text-muted-foreground",
        collapsed ? "justify-center" : "justify-start gap-2",
      )}
      activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
    >
      <item.icon aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </Link>
  );
}
