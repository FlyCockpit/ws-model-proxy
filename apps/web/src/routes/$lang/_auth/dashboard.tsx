import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  Braces,
  Cable,
  DatabaseZap,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  Network,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/$lang/_auth/dashboard")({
  component: DashboardLayout,
});

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
    to: "/$lang/dashboard/pools",
    labelKey: "dashboard:nav.pools",
    icon: Network,
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

function DashboardLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["common", "dashboard"]);

  return (
    <div className="container mx-auto flex h-full min-h-0 max-w-6xl flex-col px-4 py-4 md:py-8">
      <div className="mb-3 shrink-0 md:mb-5">
        <h1 className="text-xl font-semibold md:text-2xl">{t("dashboard:title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("dashboard:description")}</p>
      </div>

      {/* Horizontal-only: overflow-y-hidden clips accidental vertical overflow;
          overscroll-x-contain keeps horizontal swipes from chaining. Avoid
          touch-pan-x so vertical page scrolls can still begin on this strip. */}
      <div className="mb-4 min-w-0 shrink-0 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar md:mb-6">
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

      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
