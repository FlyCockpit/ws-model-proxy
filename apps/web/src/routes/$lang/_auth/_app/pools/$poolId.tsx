import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import { type SectionTab, SectionTabs } from "@/components/page-stub";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId")({
  component: PoolLayout,
});

function PoolLayout() {
  const { lang, poolId } = Route.useParams();
  const { t } = useTranslation(["dashboard", "nav"]);
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
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
      key: "aliases",
      labelKey: "dashboard:tabs.pool.aliases",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/pools/$poolId/aliases"
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
      <h1 className="min-w-0 break-all text-2xl font-semibold">
        {pool.isPending ? (
          <Skeleton className="h-8 w-56 max-w-full" />
        ) : (
          (pool.data?.name ?? t("dashboard:pages.poolOverview.title"))
        )}
      </h1>
      <SectionTabs tabs={tabs} ariaLabel={t("dashboard:pages.poolOverview.title")} />
      <Outlet />
    </div>
  );
}
