import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
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
import { ArrowRight, Check, Server, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { Sparkline } from "@/components/sparkline";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { useOfferWelcome } from "@/hooks/use-welcome-offer";
import { formatMs, formatShare } from "@/lib/format-metrics";
import { WELCOME_STEPS, type WelcomeStep } from "@/lib/welcome-steps";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/overview")({
  component: OverviewPage,
});

type Range = "24h" | "7d";
type Summary = Awaited<ReturnType<AppRouterClient["activity"]["overview"]["summary"]>>;
type NeedsYou = Awaited<ReturnType<AppRouterClient["activity"]["needsYou"]["list"]>>;
type Aliases = Awaited<ReturnType<AppRouterClient["pools"]["aliases"]["list"]>>;

/** The Overview refreshes while it is open. */
const REFRESH_MS = 30_000;

function OverviewPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const [range, setRange] = useState<Range>("24h");
  const summary = useQuery({
    ...orpc.activity.overview.summary.queryOptions({ input: { range } }),
    refetchInterval: REFRESH_MS,
    // Switching the range keeps the page while the other range loads.
    placeholderData: keepPreviousData,
  });
  const needsYou = useQuery({
    ...orpc.activity.needsYou.list.queryOptions(),
    refetchInterval: REFRESH_MS,
  });
  // Refreshed like the rest: a share or rename elsewhere can make an alias hide a pool.
  const aliases = useQuery({
    ...orpc.pools.aliases.list.queryOptions(),
    refetchInterval: REFRESH_MS,
  });
  // A first sign-in lands here: send it to Welcome once.
  useOfferWelcome(lang, summary.data?.onboarding);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="overview" />
        <SegmentedControl
          value={range}
          onChange={setRange}
          ariaLabel={t("dashboard:overview.range")}
          items={[
            { value: "24h", label: t("dashboard:overview.rangeValue.24h") },
            { value: "7d", label: t("dashboard:overview.rangeValue.7d") },
          ]}
        />
      </div>
      {summary.data && !summary.data.onboarding.done ? (
        <GettingStarted lang={lang} steps={summary.data.onboarding.steps} />
      ) : null}
      {/* What needs a person shows even when the summary fails. */}
      <NeedsYouCard lang={lang} query={needsYou} />
      <AliasShadowsCard lang={lang} aliases={aliases.data} />
      {summary.isPending ? (
        <OverviewSkeleton />
      ) : summary.isError ? (
        <InlineRetry
          message={t("dashboard:overview.loadFailed")}
          onRetry={() => summary.refetch()}
        />
      ) : (
        <>
          <KpiGrid kpis={summary.data.kpis} lang={lang} range={range} />
          <NodesStrip
            lang={lang}
            nodes={summary.data.nodes}
            online={summary.data.nodesOnline}
            total={summary.data.nodesTotal}
          />
          <PoolCards lang={lang} pools={summary.data.pools} range={range} />
        </>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-hidden="true">
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <Skeleton key={key} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

// ── Getting started ──

/** Each item opens its Welcome step. */
function StepLink({
  step,
  lang,
  children,
}: {
  step: WelcomeStep;
  lang: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/$lang/welcome"
      params={{ lang }}
      search={{ step }}
      className="inline-flex min-h-[44px] min-w-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
    >
      {children}
    </Link>
  );
}

function GettingStarted({ lang, steps }: { lang: string; steps: Summary["onboarding"]["steps"] }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    ...orpc.settings.onboarding.complete.mutationOptions(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orpc.activity.overview.summary.key() }),
  });
  const done = WELCOME_STEPS.filter((step) => steps[step]).length;
  return (
    <Card>
      <CardHeader className="flex min-w-0 flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base">{t("dashboard:overview.start.title")}</CardTitle>
          <CardDescription>
            {t("dashboard:overview.start.progress", { done, total: WELCOME_STEPS.length })}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({})}
        >
          {t("dashboard:overview.start.dismiss")}
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
          {WELCOME_STEPS.map((step, index) => (
            <li key={step} className="min-w-0">
              <StepLink step={step} lang={lang}>
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium",
                    steps[step]
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "border border-primary/40 text-primary",
                  )}
                >
                  {steps[step] ? <Check aria-hidden="true" className="size-3.5" /> : index + 1}
                </span>
                <span className={cn("truncate", steps[step] && "text-muted-foreground")}>
                  {t(`dashboard:overview.start.step.${step}`)}
                </span>
                {steps[step] ? (
                  <span className="sr-only">{t("dashboard:overview.start.stepDone")}</span>
                ) : null}
              </StepLink>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// ── Needs you ──

function NeedsYouCard({
  lang,
  query,
}: {
  lang: string;
  query: ReturnType<typeof useQuery<NeedsYou>>;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (query.isPending) return <Skeleton aria-hidden="true" className="h-24 w-full rounded-xl" />;
  if (query.isError)
    return (
      <InlineRetry
        message={t("dashboard:overview.needsYou.loadFailed")}
        onRetry={() => query.refetch()}
      />
    );
  const { items, queuedCommands } = query.data;
  if (items.length === 0 && queuedCommands === 0) return null;
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:overview.needsYou.title")}</CardTitle>
        <CardDescription>{t("dashboard:overview.needsYou.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex min-w-0 flex-col divide-y">
          {items.slice(0, 10).map((item) => (
            <li key={`${item.instanceId}-${item.need}`} className="min-w-0">
              {item.need === "STEP" ? (
                <Link
                  to="/$lang/terminals"
                  params={{ lang }}
                  className="flex min-h-[44px] min-w-0 items-center gap-3 py-2 text-sm hover:underline"
                >
                  <NeedsYouRow item={item} />
                </Link>
              ) : (
                <Link
                  to="/$lang/runtimes/$runtimeId"
                  params={{ lang, runtimeId: item.runtimeId }}
                  className="flex min-h-[44px] min-w-0 items-center gap-3 py-2 text-sm hover:underline"
                >
                  <NeedsYouRow item={item} />
                </Link>
              )}
            </li>
          ))}
          {queuedCommands > 0 ? (
            <li className="min-w-0">
              <Link
                to="/$lang/terminals"
                params={{ lang }}
                className="flex min-h-[44px] min-w-0 items-center gap-3 py-2 text-sm hover:underline"
              >
                <StatusPill tone="busy">{t("dashboard:overview.needsYou.queued")}</StatusPill>
                <span className="min-w-0 flex-1 truncate">
                  {t("dashboard:overview.needsYou.queuedCount", { count: queuedCommands })}
                </span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ) : null}
        </ul>
        {items.length > 10 ? (
          <p className="pt-2 text-xs text-muted-foreground">
            {t("dashboard:overview.needsYou.more", { count: items.length - 10 })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NeedsYouRow({ item }: { item: NeedsYou["items"][number] }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      <StatusPill tone="busy">{t(`dashboard:overview.needsYou.need.${item.need}`)}</StatusPill>
      <span className="min-w-0 flex-1 truncate">{item.runtimeName}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <TimeAgo value={item.since} />
      </span>
      <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </>
  );
}

// ── Aliases hiding pools ──

/**
 * The person's aliases named like a pool ID they could call: the alias wins for them, so the
 * pool is out of reach by its ID until they rename or delete the alias (on the alias's pool's
 * Aliases tab). Nothing shows while loading or when the list fails: it is a warning, not a gate.
 */
function AliasShadowsCard({ lang, aliases }: { lang: string; aliases: Aliases | undefined }) {
  const { t } = useTranslation(["dashboard"]);
  const hiding = (aliases?.aliases ?? []).flatMap((alias) =>
    alias.hides ? [{ ...alias, hides: alias.hides }] : [],
  );
  if (hiding.length === 0) return null;
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-amber-600" />
          {t("dashboard:overview.aliasShadows.title", { count: hiding.length })}
        </CardTitle>
        <CardDescription>{t("dashboard:overview.aliasShadows.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex min-w-0 flex-col divide-y">
          {hiding.map((alias) => (
            <li key={alias.id} className="min-w-0">
              <Link
                to="/$lang/pools/$poolId/aliases"
                params={{ lang, poolId: alias.poolId }}
                className="flex min-h-[44px] min-w-0 items-center gap-3 py-2 text-sm hover:underline"
              >
                <span className="min-w-0 flex-1 break-all">
                  {t(
                    alias.hides.shared
                      ? "dashboard:overview.aliasShadows.row"
                      : "dashboard:overview.aliasShadows.rowOwn",
                    { name: alias.name, callableId: alias.hides.callableId },
                  )}
                </span>
                <span className="shrink-0 text-xs font-medium text-primary">
                  {t("dashboard:overview.aliasShadows.fix")}
                </span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ── KPIs ──

function KpiGrid({ kpis, lang, range }: { kpis: Summary["kpis"]; lang: string; range: Range }) {
  const { t } = useTranslation(["dashboard"]);
  const none = t("dashboard:overview.kpi.none");
  const count = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const tiles = [
    { key: "requests", value: count.format(kpis.requests) },
    {
      key: "errors",
      value: count.format(kpis.errors),
      detail: kpis.requests > 0 ? formatShare(kpis.errors / kpis.requests, lang, none) : undefined,
      bad: kpis.errors > 0,
    },
    { key: "latency", value: formatMs(kpis.p95LatencyMs, lang, none) },
    { key: "ttft", value: formatMs(kpis.p95TtftMs, lang, none) },
    { key: "queueWait", value: formatMs(kpis.p95QueueWaitMs, lang, none) },
    { key: "cloudShare", value: formatShare(kpis.cloudShare, lang, none) },
  ] as const;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="overview-traffic">
      <div className="space-y-1">
        <h2 id="overview-traffic" className="text-base font-semibold">
          {t("dashboard:overview.kpi.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(`dashboard:overview.kpi.description.${range}`)}
        </p>
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.key} className="min-w-0 rounded-xl border bg-card p-3">
            <dt className="truncate text-xs text-muted-foreground">
              {t(`dashboard:overview.kpi.${tile.key}`)}
            </dt>
            <dd
              className={cn(
                "text-lg font-semibold tabular-nums",
                "bad" in tile && tile.bad && "text-destructive",
              )}
            >
              {tile.value}
              {"detail" in tile && tile.detail ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {tile.detail}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── Nodes ──

function NodesStrip({
  lang,
  nodes,
  online,
  total,
}: {
  lang: string;
  nodes: Summary["nodes"];
  online: number;
  total: number;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="overview-nodes">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-nodes" className="text-base font-semibold">
          {t("dashboard:overview.nodes.title")}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t("dashboard:overview.nodes.online", { online, total })}
        </span>
      </div>
      {nodes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <Server aria-hidden="true" className="size-4" />
            <span className="min-w-0 flex-1">{t("dashboard:overview.nodes.empty")}</span>
            <Link
              to="/$lang/nodes"
              params={{ lang }}
              className="inline-flex min-h-[44px] items-center font-medium text-primary hover:underline"
            >
              {t("dashboard:overview.nodes.add")}
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {nodes.map((node) => (
            <li key={node.id} className="min-w-0 max-w-full">
              <Link
                to="/$lang/nodes/$nodeId"
                params={{ lang, nodeId: node.id }}
                className="inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-full border bg-card px-3 text-sm hover:bg-muted"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    node.online ? "bg-emerald-500" : "bg-muted-foreground/50",
                  )}
                />
                <span className="min-w-0 truncate">{node.slug}</span>
                <span className="sr-only">
                  {node.online
                    ? t("dashboard:nodes.status.online")
                    : t("dashboard:nodes.status.offline")}
                </span>
                {node.trust === "RELAY" ? (
                  <StatusPill tone="muted">{t("dashboard:nodes.trust.relay")}</StatusPill>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > nodes.length ? (
        <Link
          to="/$lang/nodes"
          params={{ lang }}
          className="inline-flex min-h-[44px] items-center self-start text-sm font-medium text-primary hover:underline"
        >
          {t("dashboard:overview.nodes.more", { count: total - nodes.length })}
        </Link>
      ) : null}
    </section>
  );
}

// ── Pools ──

function PoolCards({
  lang,
  pools,
  range,
}: {
  lang: string;
  pools: Summary["pools"];
  range: Range;
}) {
  const { t } = useTranslation(["dashboard"]);
  const count = new Intl.NumberFormat(lang);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="overview-pools">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-pools" className="text-base font-semibold">
          {t("dashboard:overview.pools.title")}
        </h2>
        <Link
          to="/$lang/pools"
          params={{ lang }}
          className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("dashboard:overview.pools.all")}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
      {pools.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            {t("dashboard:overview.pools.empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pools.map((pool) => (
            <li key={pool.id} className="min-w-0">
              <Card size="sm" className="min-w-0">
                <CardHeader>
                  <CardTitle className="min-w-0 text-sm">
                    <Link
                      to="/$lang/pools/$poolId"
                      params={{ lang, poolId: pool.id }}
                      className="inline-flex min-h-[44px] min-w-0 max-w-full items-center break-all font-mono hover:underline"
                    >
                      {pool.callableId}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-2">
                  <Sparkline
                    values={pool.sparkline}
                    label={t(`dashboard:overview.pools.sparkline.${range}`, {
                      count: pool.requests,
                    })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:overview.pools.requests", {
                      count: pool.requests,
                      value: count.format(pool.requests),
                    })}
                    {pool.errors > 0 ? (
                      <span className="text-destructive">
                        {t("dashboard:overview.pools.separator")}
                        {t("dashboard:overview.pools.errors", {
                          count: pool.errors,
                          value: count.format(pool.errors),
                        })}
                      </span>
                    ) : null}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
