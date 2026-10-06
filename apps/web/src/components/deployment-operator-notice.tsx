import { Link } from "@tanstack/react-router";
import { escapeForDisplay } from "@ws-model-proxy/config/display-escape";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDeploymentOperatorNeeds } from "@/hooks/use-deployment-operator-needs";

/** A count of deployments waiting on the user. Renders nothing at zero. */
export function DeploymentNeedsBadge({ count, className }: { count: number; className?: string }) {
  const { t } = useTranslation("dashboard");
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white",
        className,
      )}
    >
      <span aria-hidden="true">{count > 9 ? "9+" : count}</span>
      <span className="sr-only">{t("dashboard:deploymentOperator.badge", { count })}</span>
    </span>
  );
}

/**
 * Dashboard-wide notice while a deployment waits for the user: an interactive recipe step to
 * run in an operator terminal, or a stopped interactive start to restart. Dismissing hides it
 * for the needs shown until a new one appears. Hidden on the Deployments page itself, which
 * shows each need in place.
 */
export function DeploymentOperatorNotice({ lang }: { lang: string }) {
  const { t } = useTranslation("dashboard");
  const { items } = useDeploymentOperatorNeeds();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const key = (item: { id: string; needsOperatorSince: Date | string | null }) =>
    `${item.id}:${String(item.needsOperatorSince)}`;
  const waiting = items.filter((item) => !dismissed.has(key(item)));
  const first = waiting[0];
  if (!first) return null;
  return (
    <div
      className="mb-4 flex min-w-0 flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 sm:flex-row sm:items-center"
      role="status"
    >
      <Rocket className="hidden size-5 shrink-0 text-amber-600 sm:block" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm text-amber-950 dark:text-amber-100">
        <p className="font-medium">
          {t("dashboard:deploymentOperator.noticeTitle", { count: waiting.length })}
        </p>
        <p className="break-words">
          {t(
            first.needsOperator === "RESTART"
              ? "dashboard:deploymentOperator.noticeRestart"
              : "dashboard:deploymentOperator.noticeStep",
            { endpoint: escapeForDisplay(first.endpointSlug) },
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/$lang/dashboard/deployments"
          params={{ lang }}
          className={cn(buttonVariants({ size: "touch" }))}
        >
          {t("dashboard:deploymentOperator.open")}
        </Link>
        <Button
          type="button"
          size="touch"
          variant="outline"
          onClick={() => setDismissed((current) => new Set([...current, ...waiting.map(key)]))}
        >
          {t("dashboard:notices.dismiss")}
        </Button>
      </div>
    </div>
  );
}
