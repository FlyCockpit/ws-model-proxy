import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import {
  ContributeModelForm,
  type Contributing,
  useWithdrawContributed,
} from "@/components/access/contribute";
import { ForkRuntimeDialog, type SharedDefinition } from "@/components/access/fork-runtime-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/contributions")({
  component: AccessContributionsPage,
});

type ContributablePool = Contributing["pools"][number];

function AccessContributionsPage() {
  const { t } = useTranslation(["access"]);
  const { lang } = Route.useParams();
  const pools = useQuery(orpc.access.contributing.pools.queryOptions());
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="accessContributions" />
      {pools.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-40 w-full rounded-xl" />
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
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("access:contributions.addTitle")}</CardTitle>
              <CardDescription>{t("access:contributions.addDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0">
              {pools.data.pools.every((pool) => pool.ownHardwareOnly) ? (
                <p className="text-sm text-muted-foreground">
                  {t("access:contributions.allOwnHardwareOnly")}
                </p>
              ) : (
                <ContributeModelForm data={pools.data} />
              )}
            </CardContent>
          </Card>
          <ul className="flex min-w-0 flex-col gap-3">
            {pools.data.pools.map((pool) => (
              <li key={pool.shareId}>
                <PoolCard pool={pool} lang={lang} />
              </li>
            ))}
          </ul>
        </>
      )}
      <SharedDefinitions lang={lang} />
    </div>
  );
}

function PoolCard({ pool, lang }: { pool: ContributablePool; lang: string }) {
  const { t } = useTranslation(["access"]);
  return (
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
          {t("access:shares.from", { email: pool.ownerEmail })} ·{" "}
          {t(`access:modelType.${pool.modelType}`)}
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
          <p className="text-sm text-muted-foreground">{t("access:contributions.noModels")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {pool.yourMembers.map((member) => (
              <ContributedMemberRow key={member.memberId} pool={pool} member={member} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ContributedMemberRow({
  pool,
  member,
}: {
  pool: ContributablePool;
  member: ContributablePool["yourMembers"][number];
}) {
  const { t } = useTranslation(["access"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const withdraw = useWithdrawContributed(() => setConfirmOpen(false));
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-1">
      <span className="min-w-0 break-all font-mono text-sm">{member.upstreamModelId}</span>
      <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
        {t("access:contributions.withdraw")}
      </Button>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:contributions.withdrawTitle", {
          model: member.upstreamModelId,
          pool: pool.callableId,
        })}
        description={t("access:contributions.withdrawDescription")}
        confirmLabel={t("access:contributions.withdraw")}
        isPending={withdraw.isPending}
        onConfirm={() => withdraw.mutate({ memberId: member.memberId })}
      />
    </li>
  );
}

/** Runtime definitions shared with you, each with Fork to my node. */
function SharedDefinitions({ lang }: { lang: string }) {
  const { t } = useTranslation(["access"]);
  const shares = useQuery(orpc.runtimes.shares.list.queryOptions({ input: {} }));
  const [forking, setForking] = useState<SharedDefinition | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("access:fork.sectionTitle")}</CardTitle>
        <CardDescription>{t("access:fork.sectionDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        {shares.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : shares.isError ? (
          <InlineRetry message={t("access:fork.loadFailed")} onRetry={() => shares.refetch()} />
        ) : shares.data.sharedWithMe.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access:fork.empty")}</p>
        ) : (
          shares.data.sharedWithMe.map((share) => (
            <div
              key={share.id}
              className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="break-words font-medium">{share.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("access:shares.from", { email: share.ownerEmail })} ·{" "}
                  {t("access:fork.version", { version: share.currentVersion.version })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() =>
                  setForking({
                    runtimeId: share.runtimeId,
                    name: share.name,
                    kind: share.kind,
                  })
                }
              >
                {t("access:fork.action")}
              </Button>
            </div>
          ))
        )}
      </CardContent>
      <ForkRuntimeDialog definition={forking} lang={lang} onClose={() => setForking(null)} />
    </Card>
  );
}
