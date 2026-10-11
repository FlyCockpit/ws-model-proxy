import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { type SectionTab, SectionTabs } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/access")({
  component: AccessLayout,
});

function AccessLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard", "nav"]);
  const tabs: SectionTab[] = [
    {
      key: "apiKeys",
      labelKey: "dashboard:tabs.access.apiKeys",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/access/api-keys"
          params={{ lang }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "agents",
      labelKey: "dashboard:tabs.access.agents",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/access/agents"
          params={{ lang }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "shares",
      labelKey: "dashboard:tabs.access.shares",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/access/shares"
          params={{ lang }}
          activeOptions={{ exact: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          {children}
        </Link>
      ),
    },
    {
      key: "contributions",
      labelKey: "dashboard:tabs.access.contributions",
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/access/contributions"
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
      <SectionTabs tabs={tabs} ariaLabel={t("nav:items.access")} />
      <Outlet />
    </div>
  );
}
