import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { type SectionTab, SectionTabs } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/activity")({
  component: ActivityLayout,
});

function ActivityLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard", "nav"]);
  const tabs: SectionTab[] = [
    {
      key: "metrics",
      labelKey: "dashboard:tabs.activity.metrics",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/activity"
          params={{ lang }}
          activeOptions={{ exact: true }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "requests",
      labelKey: "dashboard:tabs.activity.requests",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/activity/requests"
          params={{ lang }}
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
      <SectionTabs tabs={tabs} ariaLabel={t("nav:items.activity")} />
      <Outlet />
    </div>
  );
}
