import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Construction } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { WideContent } from "@/components/wide-content";

/** Pages of the 0.4.0 skeleton (`dashboard:pages.<key>`). */
export type StubPageKey =
  | "welcome"
  | "overview"
  | "models"
  | "test"
  | "pools"
  | "poolOverview"
  | "poolRouting"
  | "poolCloud"
  | "poolMedia"
  | "poolSharing"
  | "poolAdvanced"
  | "runtimes"
  | "runtimeNew"
  | "runtimeOverview"
  | "runtimeDefinition"
  | "runtimeAdvanced"
  | "profiles"
  | "profileEditor"
  | "nodes"
  | "nodeDetail"
  | "terminals"
  | "providers"
  | "providerDetail"
  | "accessApiKeys"
  | "accessAgents"
  | "accessShares"
  | "accessContributions"
  | "activity"
  | "activityRequests"
  | "activityCommands";

export function PageHeading({ page }: { page: StubPageKey }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="min-w-0 space-y-1">
      <h1 className="text-2xl font-semibold">{t(`dashboard:pages.${page}.title`)}</h1>
      <p className="text-sm text-muted-foreground">{t(`dashboard:pages.${page}.description`)}</p>
    </div>
  );
}

/**
 * A page that exists in the 0.4.0 route skeleton but is built in a later chunk: its heading,
 * a layout-matching placeholder and a short "not built yet" note. No data is fetched.
 */
export function PageStub({ page, heading = true }: { page: StubPageKey; heading?: boolean }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="flex min-w-0 flex-col gap-6" data-page-stub={page}>
      {heading ? <PageHeading page={page} /> : null}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Construction aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("dashboard:comingSoon.title")}
          </CardTitle>
          <CardDescription>{t("dashboard:comingSoon.description")}</CardDescription>
        </CardHeader>
        <CardContent aria-hidden="true" className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

export type SectionTab = {
  key: string;
  labelKey: string;
  /** Renders the link (typed by the caller's route). */
  render: (className: string, activeClassName: string, children: ReactNode) => ReactNode;
};

const TAB_CLASS = cn(
  buttonVariants({ variant: "ghost", size: "touch" }),
  "shrink-0 text-muted-foreground",
);
const TAB_ACTIVE_CLASS = "bg-muted text-foreground";

/** A row of tabs for a section's sub-pages; scrolls sideways inside WideContent on phones. */
export function SectionTabs({
  tabs,
  ariaLabel,
}: {
  tabs: readonly SectionTab[];
  ariaLabel: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <WideContent>
      <nav aria-label={ariaLabel} className="flex w-max gap-1">
        {tabs.map((tab) => (
          <span key={tab.key}>{tab.render(TAB_CLASS, TAB_ACTIVE_CLASS, t(tab.labelKey))}</span>
        ))}
      </nav>
    </WideContent>
  );
}
