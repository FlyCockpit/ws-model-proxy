import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { type SectionTab, SectionTabs } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId")({
  component: PoolLayout,
});

function PoolLayout() {
  const { lang, poolId } = Route.useParams();
  const { t } = useTranslation(["dashboard", "nav"]);
  const tabs: SectionTab[] = [
    {
      key: "overview",
      labelKey: "dashboard:tabs.pool.overview",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId"
          params={{ lang, poolId }}
          activeOptions={{ exact: true }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "routing",
      labelKey: "dashboard:tabs.pool.routing",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/routing"
          params={{ lang, poolId }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "cloud",
      labelKey: "dashboard:tabs.pool.cloud",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/cloud"
          params={{ lang, poolId }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "media",
      labelKey: "dashboard:tabs.pool.media",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/media"
          params={{ lang, poolId }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "sharing",
      labelKey: "dashboard:tabs.pool.sharing",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/sharing"
          params={{ lang, poolId }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "advanced",
      labelKey: "dashboard:tabs.pool.advanced",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/advanced"
          params={{ lang, poolId }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SectionTabs tabs={tabs} ariaLabel={t("dashboard:pages.poolOverview.title")} />
      <Outlet />
    </div>
  );
}
