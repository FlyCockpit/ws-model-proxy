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
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CopyableCode } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { NewPoolDialog } from "@/components/pools/new-pool-dialog";
import { Sparkline } from "@/components/sparkline";
import { type PillTone, StatusPill } from "@/components/status-pill";
import type { PoolView } from "@/lib/pool-ui";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/")({
  component: PoolsPage,
});

function poolHealth(pool: PoolView): { tone: PillTone; key: string } {
  const statuses = pool.members.map((member) => member.status);
  if (statuses.includes("serving")) return { tone: "good", key: "serving" };
  if (statuses.includes("starting")) return { tone: "busy", key: "starting" };
  if (pool.members.length === 0) return { tone: "muted", key: "empty" };
  return { tone: "muted", key: "unavailable" };
}

function PoolsPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState(0);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="pools" />
        <Button
          size="touch"
          onClick={() => {
            setOpened((count) => count + 1);
            setCreating(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t("dashboard:pool.new")}
        </Button>
      </div>
      {pools.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : pools.isError ? (
        <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pools.refetch()} />
      ) : (
        <>
          {pools.data.pools.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard:pool.emptyTitle")}</CardTitle>
                <CardDescription>{t("dashboard:pool.emptyHint")}</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {pools.data.pools.map((pool) => {
                const health = poolHealth(pool);
                return (
                  <li key={pool.id} className="min-w-0">
                    <Card className="h-full">
                      <CardHeader>
                        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
                          <Link
                            to="/$lang/pools/$poolId"
                            params={{ lang, poolId: pool.id }}
                            className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline"
                          >
                            {pool.name}
                          </Link>
                          <StatusPill tone={health.tone}>
                            {t(`dashboard:pool.health.${health.key}`)}
                          </StatusPill>
                          <StatusPill tone="info">
                            {t(`dashboard:models.type.${pool.modelType}`)}
                          </StatusPill>
                          {pool.cloud.mode !== "OFF" ? (
                            <StatusPill tone="busy">{t("dashboard:pool.cloudOn")}</StatusPill>
                          ) : null}
                        </CardTitle>
                        <CardDescription>
                          {t("dashboard:pool.memberCount", { count: pool.members.length })}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex min-w-0 flex-col gap-2">
                        <PoolFlow pool={pool} />
                        {pool.callableIds.map((id) => (
                          <CopyableCode
                            key={id}
                            value={id}
                            label={t("dashboard:models.copyId", { id })}
                          />
                        ))}
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                          <Sparkline
                            values={pool.traffic24h.sparkline}
                            label={t("dashboard:pool.traffic", {
                              count: pool.traffic24h.requests,
                            })}
                          />
                          <span>
                            {t("dashboard:pool.traffic", { count: pool.traffic24h.requests })}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
          {pools.data.sharedWithMe.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-3">
              <h2 className="text-lg font-semibold">{t("dashboard:pool.sharedWithMe")}</h2>
              <ul className="grid min-w-0 gap-3 md:grid-cols-2">
                {pools.data.sharedWithMe.map((shared) => (
                  <li key={shared.poolId} className="min-w-0">
                    <Card>
                      <CardContent className="flex min-w-0 flex-col gap-2 pt-4">
                        <p className="text-sm text-muted-foreground">
                          {t("dashboard:models.sharedBy", { owner: shared.ownerEmail })}
                        </p>
                        {shared.canUse
                          ? shared.callableIds.map((id) => (
                              <CopyableCode
                                key={id}
                                value={id}
                                label={t("dashboard:models.copyId", { id })}
                              />
                            ))
                          : null}
                        <div className="flex flex-wrap gap-2">
                          {shared.canUse ? (
                            <StatusPill tone="good">{t("dashboard:pool.canUse")}</StatusPill>
                          ) : null}
                          {shared.canContribute ? (
                            <StatusPill tone="info">{t("dashboard:pool.canContribute")}</StatusPill>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {/* A fresh key per opening, so a cancelled sheet starts over. */}
      <NewPoolDialog key={opened} open={creating} onOpenChange={setCreating} lang={lang} />
    </div>
  );
}

/** Where requests go, in order: own local members, contributed members, then the cloud. */
function PoolFlow({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard"]);
  const local = pool.members.filter((member) => member.kind === "LOCAL" && !member.shareId);
  const contributed = pool.members.filter((member) => member.kind === "LOCAL" && member.shareId);
  const cloud = pool.members.filter((member) => member.kind === "CLOUD");
  const cloudOff = pool.cloud.mode === "OFF";
  const steps = [
    { key: "local", count: local.length, off: false },
    { key: "contributed", count: contributed.length, off: false },
    { key: "cloud", count: cloud.length, off: cloudOff },
  ] as const;
  return (
    <ol
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
      aria-label={t("dashboard:pool.flow.label")}
    >
      {steps.map((step, index) => (
        <li key={step.key} className="flex items-center gap-1">
          {index > 0 ? (
            <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              "rounded-md border px-2 py-1 tabular-nums",
              step.count === 0 || step.off ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {step.off
              ? t("dashboard:pool.flow.cloudOff", { count: step.count })
              : t(`dashboard:pool.flow.${step.key}`, { count: step.count })}
          </span>
        </li>
      ))}
    </ol>
  );
}
