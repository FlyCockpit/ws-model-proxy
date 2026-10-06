import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ExternalRouteKind } from "@ws-model-proxy/api/lib/model-api-token-access";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowDown, ArrowRight, ArrowUp, Check, Circle, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { PoolFallbackBadge } from "@/components/pool-fallback-badge";
import { SegmentedControl } from "@/components/segmented-control";
import { WideContent } from "@/components/wide-content";
import { useOverviewRange } from "@/hooks/use-overview-range";
import { orpc } from "@/utils/orpc";
import {
  computeDelta,
  type DeltaKind,
  formatCount,
  formatDeltaMagnitude,
  formatDuration,
  formatPercent,
  type OverviewHealth,
  type OverviewMetrics,
  type OverviewStats,
} from "./overview-format";
import { OverviewPoolCard } from "./overview-pool-card";

/** Auto-refresh cadence. TanStack Query pauses intervals while the tab is hidden. */
export const OVERVIEW_REFETCH_INTERVAL_MS = 30_000;

type DashboardT = ReturnType<typeof useTranslation<"dashboard">>["t"];

export function OverviewPage({ lang }: { lang: string }) {
  const { t, i18n } = useTranslation("dashboard");
  const [range, setRange] = useOverviewRange();
  const metrics = useQuery({
    ...orpc.overview.metrics.queryOptions({ input: { range } }),
    refetchInterval: OVERVIEW_REFETCH_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
  const health = useQuery({
    ...orpc.overview.health.queryOptions(),
    refetchInterval: OVERVIEW_REFETCH_INTERVAL_MS,
  });
  // Optional: the health tile is omitted when runtimes cannot be read.
  const runtimes = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    refetchInterval: OVERVIEW_REFETCH_INTERVAL_MS,
    retry: false,
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t("overview.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("overview.description")}
          </p>
          {metrics.dataUpdatedAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("overview.updatedAt", {
                time: new Date(metrics.dataUpdatedAt).toLocaleTimeString(i18n.language, {
                  timeStyle: "short",
                }),
              })}
            </p>
          ) : null}
        </div>
        <SegmentedControl
          value={range}
          onChange={setRange}
          ariaLabel={t("overview.rangeLabel")}
          items={(["1h", "24h", "7d"] as const).map((value) => ({
            value,
            label: t(`overview.ranges.${value}`),
          }))}
          className="shrink-0"
        />
      </div>

      {metrics.isPending ? (
        <OverviewSkeleton />
      ) : metrics.isError ? (
        <InlineRetry
          className="py-12"
          message={t("overview.loadFailed")}
          onRetry={() => void metrics.refetch()}
        />
      ) : (
        <OverviewContent
          lang={lang}
          metrics={metrics.data}
          health={health.data}
          runtimes={runtimes.data}
          healthPending={health.isPending}
          healthError={health.isError}
          onRetryHealth={() => void health.refetch()}
          t={t}
        />
      )}
    </div>
  );
}

function OverviewContent({
  lang,
  metrics,
  health,
  runtimes,
  healthPending,
  healthError,
  onRetryHealth,
  t,
}: {
  lang: string;
  metrics: OverviewMetrics;
  health: OverviewHealth | undefined;
  runtimes: OverviewRuntime[] | undefined;
  healthPending: boolean;
  healthError: boolean;
  onRetryHealth: () => void;
  t: DashboardT;
}) {
  const steps = health ? setupSteps(metrics, health) : null;
  // The tracker stays until every step is done, not just until a CLI and a pool exist.
  const needsSetup = steps?.some((step) => !step.done) ?? false;
  const hasTraffic =
    metrics.totals.current.requests > 0 ||
    metrics.pools.some((pool) => pool.current.requests > 0) ||
    metrics.direct.length > 0 ||
    metrics.sharedPools.length > 0;

  return (
    <>
      {needsSetup && steps ? <SetupChecklist lang={lang} steps={steps} t={t} /> : null}

      {/* Health answers "is it working?", so it comes before traffic. */}
      {healthPending ? (
        <HealthSkeleton />
      ) : healthError || !health ? (
        <InlineRetry message={t("overview.healthLoadFailed")} onRetry={onRetryHealth} />
      ) : (
        <HealthStrip lang={lang} health={health} runtimes={runtimes} t={t} />
      )}

      <KpiRow metrics={metrics} t={t} />

      {!hasTraffic && !needsSetup ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-sm font-medium">{t("overview.empty.title")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("overview.empty.description")}</p>
        </div>
      ) : null}

      {metrics.pools.length > 0 ? (
        <section aria-labelledby="overview-pools" className="flex min-w-0 flex-col gap-4">
          <h2 id="overview-pools" className="text-base font-semibold">
            {t("overview.pools.title")}
          </h2>
          {metrics.pools.map((pool, index) => (
            <OverviewPoolCard
              key={pool.poolId}
              pool={pool}
              range={metrics.range}
              lang={lang}
              defaultOpen={index < 2}
            />
          ))}
        </section>
      ) : null}

      {metrics.direct.length > 0 ? <DirectTable metrics={metrics} t={t} /> : null}

      {metrics.sharedPools.length > 0 ? <SharedPoolsTable metrics={metrics} t={t} /> : null}
    </>
  );
}

function DeltaLine({
  kind,
  current,
  previous,
  better,
  t,
}: {
  kind: DeltaKind;
  current: number | null;
  previous: number | null;
  /** Which direction is an improvement; omitted for neutral measures such as volume. */
  better?: "up" | "down";
  t: DashboardT;
}) {
  const { i18n } = useTranslation();
  const delta = computeDelta(kind, current, previous);
  if (!delta)
    return <p className="mt-1 text-xs text-muted-foreground">{t("overview.kpi.deltaNone")}</p>;
  const Icon = delta.direction === "up" ? ArrowUp : delta.direction === "down" ? ArrowDown : Minus;
  const value = formatDeltaMagnitude(i18n.language, delta, (points) =>
    t("overview.kpi.deltaPoints", { value: points }),
  );
  const tone =
    !better || delta.direction === "flat"
      ? "text-muted-foreground"
      : delta.direction === better
        ? "text-state-success"
        : "text-destructive";
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-xs", tone)}>
      <Icon aria-hidden="true" className="size-3" />
      <span>
        {delta.direction === "up"
          ? t("overview.kpi.deltaUp", { value })
          : delta.direction === "down"
            ? t("overview.kpi.deltaDown", { value })
            : t("overview.kpi.deltaFlat")}
      </span>
    </p>
  );
}

function KpiTile({
  label,
  value,
  help,
  children,
}: {
  label: string;
  value: string;
  help?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background p-3">
      <dt className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {help ? <Help>{help}</Help> : null}
      </dt>
      <dd className="mt-1 truncate text-xl font-semibold tabular-nums">{value}</dd>
      {children}
    </div>
  );
}

function KpiRow({ metrics, t }: { metrics: OverviewMetrics; t: DashboardT }) {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const current: OverviewStats = metrics.totals.current;
  const previous: OverviewStats = metrics.totals.previous;
  const previousOrNull = (value: number | null) => (previous.requests > 0 ? value : null);
  const optionalDuration = (value: number | null) =>
    value === null ? t("overview.noValue") : formatDuration(locale, value);
  return (
    <section aria-label={t("overview.kpi.sectionLabel")}>
      <dl className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label={t("overview.kpi.requests")} value={formatCount(locale, current.requests)}>
          <DeltaLine
            kind="count"
            current={current.requests}
            previous={previousOrNull(previous.requests)}
            t={t}
          />
        </KpiTile>
        <KpiTile
          label={t("overview.kpi.errorRate")}
          help={t("overview.kpi.help.errorRate")}
          value={
            current.errorRate === null
              ? t("overview.noValue")
              : formatPercent(locale, current.errorRate)
          }
        >
          <DeltaLine
            kind="rate"
            current={current.errorRate}
            previous={previousOrNull(previous.errorRate)}
            better="down"
            t={t}
          />
        </KpiTile>
        <KpiTile
          label={t("overview.kpi.cacheHitRate")}
          help={t("overview.kpi.cacheHitRateHint")}
          value={
            current.cacheHitRate === null
              ? t("overview.notReported")
              : formatPercent(locale, current.cacheHitRate)
          }
        >
          <DeltaLine
            kind="rate"
            current={current.cacheHitRate}
            previous={previous.cacheHitRate}
            better="up"
            t={t}
          />
        </KpiTile>
        <KpiTile
          label={t("overview.kpi.p95Latency")}
          help={t("overview.kpi.help.p95Latency")}
          value={optionalDuration(current.p95LatencyMs)}
        >
          <DeltaLine
            kind="duration"
            current={current.p95LatencyMs}
            previous={previous.p95LatencyMs}
            better="down"
            t={t}
          />
        </KpiTile>
        <KpiTile
          label={t("overview.kpi.p95Ttft")}
          help={t("overview.kpi.help.p95Ttft")}
          value={optionalDuration(current.p95TtftMs)}
        >
          <DeltaLine
            kind="duration"
            current={current.p95TtftMs}
            previous={previous.p95TtftMs}
            better="down"
            t={t}
          />
        </KpiTile>
        <KpiTile
          label={t("overview.kpi.tokens")}
          value={t("overview.kpi.tokensValue", {
            input: formatCount(locale, current.inputTokens),
            output: formatCount(locale, current.outputTokens),
          })}
        >
          <DeltaLine
            kind="count"
            current={current.inputTokens + current.outputTokens}
            previous={previousOrNull(previous.inputTokens + previous.outputTokens)}
            t={t}
          />
        </KpiTile>
      </dl>
    </section>
  );
}

function HealthTile({
  label,
  value,
  detail,
  healthy,
  help,
  action,
}: {
  label: string;
  value: string;
  detail?: string;
  healthy: boolean;
  help?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border bg-background p-3">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">{label}</span>
          {help ? <Help>{help}</Help> : null}
        </p>
        <p className="mt-1 flex items-center gap-2 text-base font-semibold tabular-nums">
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0", healthy ? "bg-chart-6" : "bg-chart-2")}
          />
          {value}
        </p>
        {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function ReviewLink({
  children,
  ...link
}: { children: ReactNode } & (
  | { to: "/$lang/dashboard/clis"; params: { lang: string } }
  | { to: "/$lang/dashboard/pools"; params: { lang: string } }
  | { to: "/$lang/dashboard/runtimes"; params: { lang: string } }
  | { to: "/$lang/dashboard/pools/$poolId"; params: { lang: string; poolId: string } }
)) {
  return (
    <Link
      {...link}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-[44px] shrink-0")}
    >
      {children}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

type OverviewRuntime = Awaited<ReturnType<AppRouterClient["capacityManagement"]["list"]>>[number];

function HealthStrip({
  lang,
  health,
  runtimes,
  t,
}: {
  lang: string;
  health: OverviewHealth;
  runtimes: OverviewRuntime[] | undefined;
  t: DashboardT;
}) {
  const queued = runtimes?.filter((runtime) => runtime._count.CapacityWaiters > 0) ?? [];
  const cliHealthy = health.clis.online === health.clis.total;
  const endpointsHealthy = health.endpoints.healthy === health.endpoints.total;
  const membersHealthy =
    health.poolMembers.degradedCount === 0 && health.poolMembers.circuitOpenCount === 0;
  const firstProblemMember = health.poolMembers.circuitOpen[0] ?? health.poolMembers.degraded[0];
  return (
    <section aria-label={t("overview.health.sectionLabel")}>
      <div
        className={cn(
          "grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2",
          runtimes ? "xl:grid-cols-4" : "xl:grid-cols-3",
        )}
      >
        <HealthTile
          label={t("overview.health.clis")}
          healthy={cliHealthy}
          value={
            health.clis.total === 0
              ? t("overview.health.noneConfigured")
              : t("overview.health.ratio", { value: health.clis.online, total: health.clis.total })
          }
          detail={health.clis.offline.map((cli) => cli.displayName).join(", ") || undefined}
          action={
            cliHealthy ? null : (
              <ReviewLink to="/$lang/dashboard/clis" params={{ lang }}>
                {t("overview.health.reviewClis")}
              </ReviewLink>
            )
          }
        />
        <HealthTile
          label={t("overview.health.endpoints")}
          healthy={endpointsHealthy}
          value={
            health.endpoints.total === 0
              ? t("overview.health.noneConfigured")
              : t("overview.health.ratio", {
                  value: health.endpoints.healthy,
                  total: health.endpoints.total,
                })
          }
          detail={
            health.endpoints.unhealthy.map((endpoint) => endpoint.label).join(", ") || undefined
          }
          action={
            endpointsHealthy ? null : (
              <ReviewLink to="/$lang/dashboard/clis" params={{ lang }}>
                {t("overview.health.reviewEndpoints")}
              </ReviewLink>
            )
          }
        />
        <HealthTile
          label={t("overview.health.members")}
          healthy={membersHealthy}
          value={
            health.poolMembers.total === 0
              ? t("overview.health.noneConfigured")
              : membersHealthy
                ? t("overview.health.allHealthy")
                : t("overview.health.membersValue", {
                    degraded: health.poolMembers.degradedCount,
                    open: health.poolMembers.circuitOpenCount,
                  })
          }
          action={
            firstProblemMember ? (
              <ReviewLink
                to="/$lang/dashboard/pools/$poolId"
                params={{ lang, poolId: firstProblemMember.poolId }}
              >
                {t("overview.health.reviewMember", { pool: firstProblemMember.poolName })}
              </ReviewLink>
            ) : null
          }
        />
        {runtimes ? (
          <HealthTile
            label={t("overview.health.runtimes")}
            help={t("overview.health.runtimesHelp")}
            healthy={queued.length === 0}
            value={
              runtimes.length === 0
                ? t("overview.health.noneConfigured")
                : queued.length === 0
                  ? t("overview.health.noQueue")
                  : t("overview.health.ratio", { value: queued.length, total: runtimes.length })
            }
            detail={queued.map((runtime) => runtime.label).join(", ") || undefined}
            action={
              queued.length ? (
                <ReviewLink to="/$lang/dashboard/runtimes" params={{ lang }}>
                  {t("overview.health.reviewRuntimes")}
                </ReviewLink>
              ) : null
            }
          />
        ) : null}
      </div>
    </section>
  );
}

type TrafficRow = {
  routes?: readonly ExternalRouteKind[];
  providers?: readonly string[];
  key: string;
  title: string;
  subtitle: string | null;
  stats: OverviewStats;
};

function DirectTable({ metrics, t }: { metrics: OverviewMetrics; t: DashboardT }) {
  return (
    <TrafficTable
      id="overview-direct"
      title={t("overview.direct.title")}
      description={t("overview.direct.description")}
      firstColumn={t("overview.direct.columns.model")}
      rows={metrics.direct.map((row) => ({
        key: row.executionTargetId || "unresolved",
        title: row.model ?? t("overview.direct.unresolved"),
        subtitle: row.location,
        stats: row.current,
      }))}
      t={t}
    />
  );
}

/**
 * The viewer's own requests to pools other users share with them. The API
 * returns per-pool totals of the viewer's traffic only, never the owner's
 * members or other requesters.
 */
function SharedPoolsTable({ metrics, t }: { metrics: OverviewMetrics; t: DashboardT }) {
  return (
    <TrafficTable
      id="overview-shared"
      title={t("overview.shared.title")}
      description={t("overview.shared.description")}
      firstColumn={t("overview.shared.columns.pool")}
      rows={metrics.sharedPools.map((row) => ({
        key: row.poolId,
        routes: row.externalRoutes,
        providers: row.providerTypes,
        title: row.available && row.name ? row.name : t("overview.shared.unavailable"),
        subtitle: row.ownerSlug ? t("overview.shared.owner", { owner: row.ownerSlug }) : null,
        stats: row.current,
      }))}
      t={t}
    />
  );
}

function TrafficTable({
  id,
  title,
  description,
  firstColumn,
  rows,
  t,
}: {
  id: string;
  title: string;
  description: string;
  firstColumn: string;
  rows: TrafficRow[];
  t: DashboardT;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-md border bg-background">
      <div className="border-b p-4">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <WideContent className="p-4">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {firstColumn}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t("overview.direct.columns.requests")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t("overview.direct.columns.errors")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t("overview.direct.columns.cache")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t("overview.direct.columns.p95")}
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                {t("overview.direct.columns.tokens")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-0">
                <td className="max-w-64 py-2 pr-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{row.title}</span>
                    {row.routes && row.routes.length > 0 ? (
                      <PoolFallbackBadge routes={row.routes} providers={row.providers} />
                    ) : null}
                  </div>
                  {row.subtitle ? (
                    <div className="truncate text-xs text-muted-foreground">{row.subtitle}</div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCount(locale, row.stats.requests)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.stats.errorRate === null
                    ? t("overview.noValue")
                    : formatPercent(locale, row.stats.errorRate)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.stats.cacheHitRate === null
                    ? t("overview.notReported")
                    : formatPercent(locale, row.stats.cacheHitRate)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.stats.p95LatencyMs === null
                    ? t("overview.noValue")
                    : formatDuration(locale, row.stats.p95LatencyMs)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {t("overview.kpi.tokensValue", {
                    input: formatCount(locale, row.stats.inputTokens),
                    output: formatCount(locale, row.stats.outputTokens),
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WideContent>
    </section>
  );
}

type SetupStep = {
  id: "connectCli" | "addEndpoint" | "createPool" | "createToken" | "tryChat";
  done: boolean;
  link:
    | { to: "/$lang/dashboard/clis" }
    | { to: "/$lang/dashboard/pools/new" }
    | { to: "/$lang/dashboard/api-tokens" }
    | { to: "/$lang/dashboard/chat-test" };
};

function setupSteps(metrics: OverviewMetrics, health: OverviewHealth): SetupStep[] {
  return [
    { id: "connectCli", done: health.clis.total > 0, link: { to: "/$lang/dashboard/clis" } },
    { id: "addEndpoint", done: health.endpoints.total > 0, link: { to: "/$lang/dashboard/clis" } },
    { id: "createPool", done: metrics.setup.hasPools, link: { to: "/$lang/dashboard/pools/new" } },
    {
      id: "createToken",
      done: health.modelApiTokens > 0,
      link: { to: "/$lang/dashboard/api-tokens" },
    },
    {
      id: "tryChat",
      done: metrics.pools.some((pool) => pool.current.requests > 0),
      link: { to: "/$lang/dashboard/chat-test" },
    },
  ];
}

function SetupChecklist({ lang, steps, t }: { lang: string; steps: SetupStep[]; t: DashboardT }) {
  const doneCount = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  return (
    <section
      aria-labelledby="overview-setup"
      className="min-w-0 rounded-md border bg-background p-4"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 id="overview-setup" className="text-base font-semibold">
          {t("overview.setup.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("overview.setup.progress", { done: doneCount, total: steps.length })}
          {next
            ? ` · ${t("overview.setup.next", { step: t(`overview.setup.steps.${next.id}.title`) })}`
            : null}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t("overview.setup.description")}</p>
      <div
        role="progressbar"
        aria-label={t("overview.setup.title")}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={doneCount}
        className="mt-3 flex gap-1"
      >
        {steps.map((step) => (
          <span
            key={step.id}
            className={cn("h-1.5 flex-1 rounded-full", step.done ? "bg-state-success" : "bg-muted")}
          />
        ))}
      </div>
      <ol className="mt-4 flex flex-col gap-2">
        {steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between",
              step === next && "border-primary/50 bg-primary/5",
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              {step.done ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-chart-6" />
              ) : (
                <Circle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t(`overview.setup.steps.${step.id}.title`)}
                  <span className="sr-only">
                    {" "}
                    ({step.done ? t("overview.setup.done") : t("overview.setup.todo")})
                  </span>
                </p>
                {step.done ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t(`overview.setup.steps.${step.id}.description`)}
                  </p>
                )}
              </div>
            </div>
            {step.done ? null : (
              <Link
                {...step.link}
                params={{ lang }}
                className={cn(
                  buttonVariants({ variant: step === next ? "default" : "outline", size: "sm" }),
                  "min-h-[44px] shrink-0 self-start sm:self-auto",
                )}
              >
                {t(`overview.setup.steps.${step.id}.action`)}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function HealthSkeleton() {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
      data-testid="overview-health-skeleton"
    >
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="rounded-md border p-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="overview-skeleton">
      <HealthSkeleton />
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="rounded-md border p-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-16" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="rounded-md border">
        <div className="border-b p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <div className="p-4">
          <Skeleton className="h-56 w-full" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
