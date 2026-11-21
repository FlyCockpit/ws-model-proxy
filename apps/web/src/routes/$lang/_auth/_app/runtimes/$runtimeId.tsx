import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import { type SectionTab, SectionTabs } from "@/components/page-stub";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId")({
  component: RuntimeLayout,
});

function RuntimeLayout() {
  const { lang, runtimeId } = Route.useParams();
  const { t } = useTranslation(["dashboard", "nav"]);
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));
  const tabs: SectionTab[] = [
    {
      key: "overview",
      labelKey: "dashboard:tabs.runtime.overview",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/runtimes/$runtimeId"
          params={{ lang, runtimeId }}
          activeOptions={{ exact: true }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "definition",
      labelKey: "dashboard:tabs.runtime.definition",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/runtimes/$runtimeId/definition"
          params={{ lang, runtimeId }}
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
      labelKey: "dashboard:tabs.runtime.advanced",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/runtimes/$runtimeId/advanced"
          params={{ lang, runtimeId }}
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
        {runtime.isPending ? (
          <Skeleton className="h-8 w-56 max-w-full" />
        ) : (
          (runtime.data?.name ?? t("dashboard:pages.runtimeOverview.title"))
        )}
      </h1>
      <SectionTabs tabs={tabs} ariaLabel={t("dashboard:pages.runtimeOverview.title")} />
      <Outlet />
    </div>
  );
}
