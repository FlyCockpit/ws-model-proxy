import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusPill } from "@/components/status-pill";
import { orpc } from "@/utils/orpc";

/**
 * Welcome step 2: model servers are runtimes. Startable ones come from a preset; a server that
 * already runs becomes an always-on runtime (auto-detection is not built yet, so nothing is
 * "found" here).
 */
export function ServersStep({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const list = runtimes.data?.runtimes ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <section className="flex min-w-0 flex-col items-start gap-2 rounded-lg border p-4">
          <h3 className="font-medium">{t("dashboard:welcome.runtime.presetTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("dashboard:welcome.runtime.presetHint")}
          </p>
          <Link
            to="/$lang/runtimes/new"
            params={{ lang }}
            className={buttonVariants({ size: "touch", className: "mt-auto" })}
          >
            <Plus aria-hidden="true" />
            {t("dashboard:welcome.runtime.presetAction")}
          </Link>
        </section>
        <section className="flex min-w-0 flex-col items-start gap-2 rounded-lg border p-4">
          <h3 className="font-medium">{t("dashboard:welcome.runtime.runningTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("dashboard:welcome.runtime.runningHint")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:welcome.runtime.noDetection")}
          </p>
          <Link
            to="/$lang/runtimes/new"
            params={{ lang }}
            className={buttonVariants({ variant: "outline", size: "touch", className: "mt-auto" })}
          >
            {t("dashboard:welcome.runtime.runningAction")}
          </Link>
        </section>
      </div>
      {runtimes.isPending ? (
        <Skeleton aria-hidden="true" className="h-16 w-full rounded-lg" />
      ) : list.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {t("dashboard:welcome.runtime.yours", { count: list.length })}
          </p>
          <ul className="flex min-w-0 flex-col divide-y">
            {list.map((runtime) => (
              <li key={runtime.id} className="flex min-w-0 flex-wrap items-center gap-2">
                <Link
                  to="/$lang/runtimes/$runtimeId"
                  params={{ lang, runtimeId: runtime.id }}
                  className="inline-flex min-h-11 min-w-0 items-center break-all underline-offset-4 hover:underline"
                >
                  {runtime.name}
                </Link>
                <StatusPill tone="info">{t(`dashboard:runtime.kind.${runtime.kind}`)}</StatusPill>
                <span className="text-xs text-muted-foreground">
                  {t("dashboard:welcome.runtime.models", { count: runtime.models.length })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
