import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { StatusPill } from "@/components/status-pill";
import type { RuntimeSummary } from "@/lib/pool-ui";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/")({
  component: RuntimesPage,
});

function RuntimesPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const pools = useQuery(orpc.pools.list.queryOptions());
  const pooled = new Set(
    (pools.data?.pools ?? []).flatMap((pool) =>
      pool.members.flatMap((member) => (member.runtimeId ? [member.runtimeId] : [])),
    ),
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="runtimes" />
        <Link
          to="/$lang/runtimes/new"
          params={{ lang }}
          className={buttonVariants({ size: "touch" })}
        >
          <Plus aria-hidden="true" />
          {t("dashboard:runtime.new")}
        </Link>
      </div>
      {runtimes.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : runtimes.isError ? (
        <InlineRetry
          message={t("dashboard:runtime.loadFailed")}
          onRetry={() => runtimes.refetch()}
        />
      ) : runtimes.data.runtimes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard:runtime.emptyTitle")}</CardTitle>
            <CardDescription>{t("dashboard:runtime.emptyHint")}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="grid min-w-0 gap-3 md:grid-cols-2">
          {runtimes.data.runtimes.map((runtime) => (
            <li key={runtime.id} className="min-w-0">
              <RuntimeCard
                runtime={runtime}
                inPool={pooled.has(runtime.id)}
                poolsKnown={pools.isSuccess}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuntimeCard({
  runtime,
  inPool,
  poolsKnown,
}: {
  runtime: RuntimeSummary;
  inPool: boolean;
  poolsKnown: boolean;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const counts = runtime.instances;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
          <Link
            to="/$lang/runtimes/$runtimeId"
            params={{ lang, runtimeId: runtime.id }}
            className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline"
          >
            {runtime.name}
          </Link>
          <StatusPill tone="info">{t(`dashboard:runtime.kind.${runtime.kind}`)}</StatusPill>
          {runtime.service ? (
            <StatusPill tone="muted">{t("dashboard:runtime.service")}</StatusPill>
          ) : poolsKnown && !inPool ? (
            <StatusPill tone="busy">{t("dashboard:runtime.notInPool")}</StatusPill>
          ) : null}
        </CardTitle>
        <CardDescription className="break-all font-mono">
          {runtime.slug} · v{runtime.currentVersion.version}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2 text-sm">
        {runtime.models.length > 0 ? (
          <p className="break-all text-muted-foreground">{runtime.models.join(", ")}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {counts.running > 0 ? (
            <StatusPill tone="good">
              {t("dashboard:runtime.running", { count: counts.running })}
            </StatusPill>
          ) : null}
          {counts.starting > 0 ? (
            <StatusPill tone="busy">
              {t("dashboard:runtime.starting", { count: counts.starting })}
            </StatusPill>
          ) : null}
          {counts.failed > 0 ? (
            <StatusPill tone="bad">
              {t("dashboard:runtime.failed", { count: counts.failed })}
            </StatusPill>
          ) : null}
          {counts.needsYou > 0 ? (
            <StatusPill tone="bad">
              {t("dashboard:runtime.needsYou", { count: counts.needsYou })}
            </StatusPill>
          ) : null}
          {counts.running + counts.starting + counts.failed === 0 ? (
            <StatusPill tone="muted">{t("dashboard:runtime.notRunning")}</StatusPill>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
