import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
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
