import { useQuery } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { InlineRetry } from "@/components/inline-retry";
import { formatPercent } from "@/components/overview/overview-format";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

const CHART_HEIGHT_PX = 224;

type CacheStats = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["poolCacheStats"]>>;
type CacheRange = "1h" | "24h" | "7d";

const RANGE_MINUTES: Record<CacheRange, number> = {
  "1h": 60,
  "24h": 1_440,
  "7d": 10_080,
};

function rateLabel(locale: string, value: number | null, t: (key: string) => string): string {
  return value === null
    ? t("dashboard:pools.cacheStats.notReported")
    : formatPercent(locale, value);
}

export function PoolCacheStats({ poolId }: { poolId: string }) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const locale = i18n.language;
  const [range, setRange] = useState<CacheRange>("24h");
  const query = useQuery({
    ...orpc.forwarderManagement.poolCacheStats.queryOptions({
      input: { poolId, lastMinutes: RANGE_MINUTES[range] },
    }),
    refetchInterval: 30_000,
  });

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="pool-cache-stats-title">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="pool-cache-stats-title" className="text-base font-semibold">
            {t("dashboard:pools.cacheStats.title")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard:pools.cacheStats.description")}
          </p>
        </div>
        <SegmentedControl
          value={range}
          onChange={setRange}
          ariaLabel={t("dashboard:pools.cacheStats.rangeLabel")}
          items={(["1h", "24h", "7d"] as const).map((value) => ({
            value,
            label: t(`dashboard:pools.cacheStats.ranges.${value}`),
          }))}
          className="shrink-0"
        />
      </div>
      {query.isPending ? (
        <CacheStatsSkeleton />
      ) : query.isError ? (
        <InlineRetry
          message={t("dashboard:pools.cacheStats.loadFailed")}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <CacheStatsBody stats={query.data} locale={locale} t={t} />
      )}
    </section>
  );
}

function CacheStatsSkeleton() {
  return (
    <div className="space-y-3" data-testid="pool-cache-stats-skeleton" aria-busy="true">
      <div className="flex min-w-0 flex-wrap gap-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="w-full" style={{ height: CHART_HEIGHT_PX }} />
    </div>
  );
}

function CacheStatsBody({
  stats,
  locale,
  t,
}: {
  stats: CacheStats;
  locale: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const empty = stats.requests === 0;
  const noCache = stats.hitRate === null;
  const lowCoverage = stats.notes.includes("low_coverage");
  const rows = stats.series.map((point) => ({
    start: point.start,
    hitRate: point.hitRate,
    continuationHitRate: point.continuationHitRate,
  }));

  return (
    <div className="min-w-0 space-y-3">
      <p className="text-sm">
        {t("dashboard:pools.cacheStats.hitRate")}: {rateLabel(locale, stats.hitRate, t)}
        {" · "}
        {t("dashboard:pools.cacheStats.continuationHitRate")}:{" "}
        {rateLabel(locale, stats.continuationHitRate, t)}
        {" · "}
        {t("dashboard:pools.cacheStats.coverage")}: {rateLabel(locale, stats.coverage, t)}
      </p>
      {stats.stability.median !== null ? (
        <p className="text-xs text-muted-foreground">
          {t("dashboard:pools.cacheStats.stability", {
            median: formatPercent(locale, stats.stability.median),
            p10:
              stats.stability.p10 === null
                ? t("dashboard:pools.cacheStats.notReported")
                : formatPercent(locale, stats.stability.p10),
            stddev:
              stats.stability.stddev === null
                ? t("dashboard:pools.cacheStats.notReported")
                : formatPercent(locale, stats.stability.stddev),
          })}
        </p>
      ) : null}
      {lowCoverage && stats.coverage !== null ? (
        <p className="text-xs text-muted-foreground" data-testid="pool-cache-stats-low-coverage">
          {t("dashboard:pools.cacheStats.lowCoverage", {
            coverage: formatPercent(locale, stats.coverage),
          })}
        </p>
      ) : null}
      {empty ? (
        <p
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height: CHART_HEIGHT_PX }}
          data-testid="pool-cache-stats-empty"
        >
          {t("dashboard:pools.cacheStats.noTraffic")}
        </p>
      ) : noCache ? (
        <p
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height: CHART_HEIGHT_PX }}
          data-testid="pool-cache-stats-no-cache"
        >
          {t("dashboard:pools.cacheStats.empty")}
        </p>
      ) : (
        <figure className="m-0 min-w-0">
          <figcaption className="sr-only">{t("dashboard:pools.cacheStats.chartLabel")}</figcaption>
          <div
            className="min-w-0 max-w-full overflow-x-hidden"
            data-testid="pool-cache-stats-chart"
          >
            <LineChart
              width={640}
              height={CHART_HEIGHT_PX}
              data={rows}
              margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis dataKey="start" hide />
              <YAxis domain={[0, 1]} hide />
              <Line
                type="monotone"
                dataKey="hitRate"
                stroke="var(--chart-1)"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="continuationHitRate"
                stroke="var(--chart-2)"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </div>
        </figure>
      )}
    </div>
  );
}
