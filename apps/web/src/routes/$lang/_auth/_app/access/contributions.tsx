import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/contributions")({
  component: AccessContributionsPage,
});

function AccessContributionsPage() {
  const { t } = useTranslation(["access"]);
  const { lang } = Route.useParams();
  const pools = useQuery(orpc.access.contributing.pools.queryOptions());
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="accessContributions" />
      {pools.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : pools.isError ? (
        <InlineRetry
          message={t("access:contributions.loadFailed")}
          onRetry={() => pools.refetch()}
        />
      ) : pools.data.pools.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            {t("access:contributions.empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {pools.data.pools.map((pool) => (
            <li key={pool.shareId}>
              <Card>
                <CardHeader>
                  <CardTitle className="min-w-0 text-base">
                    <Link
                      to="/$lang/pools/$poolId"
                      params={{ lang, poolId: pool.poolId }}
                      className="inline-flex min-h-11 items-center break-all font-mono underline-offset-4 hover:underline"
                    >
                      {pool.callableId}
                    </Link>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {t("access:shares.from", { email: pool.ownerEmail })} · {pool.modelType}
                  </p>
                </CardHeader>
                <CardContent className="min-w-0 space-y-2">
                  {pool.ownHardwareOnly ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {t("access:contributions.ownHardwareOnly")}
                    </p>
                  ) : null}
                  <p className="text-sm font-medium">{t("access:contributions.yourModels")}</p>
                  {pool.yourMembers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("access:contributions.noModels")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {pool.yourMembers.map((member) => (
                        <li key={member.memberId} className="break-all font-mono text-sm">
                          {member.upstreamModelId}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("access:contributions.addHint")}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
