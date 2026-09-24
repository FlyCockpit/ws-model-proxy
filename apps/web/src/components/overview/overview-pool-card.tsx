import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@ws-model-proxy/ui/components/chart";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { WideContent } from "@/components/wide-content";
import {
  chartRows,
  chartSeriesForMembers,
  formatCount,
  formatDuration,
  formatPercent,
  type OverviewMember,
  type OverviewMetrics,
  type OverviewPool,
} from "./overview-format";

const CHART_HEIGHT_PX = 224;

function memberLabel(
  member: OverviewMember,
  t: ReturnType<typeof useTranslation<"dashboard">>["t"],
): { primary: string; secondary: string | null } {
  if (member.present && member.model) return { primary: member.model, secondary: member.location };
  if (member.seriesKey === "") return { primary: t("overview.pools.unrouted"), secondary: null };
  return { primary: t("overview.pools.removedMember"), secondary: null };
}

function InlineBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex min-w-24 items-center gap-2">
      <span className="w-10 shrink-0 text-right tabular-nums">{label}</span>
      <span aria-hidden="true" className="h-1.5 min-w-0 flex-1 bg-muted">
        <span
          className="block h-full bg-primary/70"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%` }}
        />
      </span>
    </div>
  );
}

function tickTime(locale: string, range: OverviewMetrics["range"], iso: string): string {
  const date = new Date(iso);
  return range === "7d"
    ? new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric" }).format(date)
    : new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function OverviewPoolCard({
  pool,
  range,
  lang,
}: {
  pool: OverviewPool;
  range: OverviewMetrics["range"];
  lang: string;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const locale = i18n.language;
  const series = chartSeriesForMembers(pool.members);
  const config: ChartConfig = Object.fromEntries(
    series.map((entry) => {
      const member = pool.members.find((candidate) => candidate.seriesKey === entry.seriesKeys[0]);
      const label =
        entry.key === "other" || !member
          ? t("overview.pools.other")
          : memberLabel(member, t).primary;
      return [entry.key, { label, color: `var(--chart-${entry.colorSlot})` }];
    }),
  );
  const rows = chartRows(pool, series);
  const cache =
    pool.current.cacheHitRate === null
      ? t("overview.notReported")
      : formatPercent(locale, pool.current.cacheHitRate);

  return (
    <section
      aria-labelledby={`overview-pool-${pool.poolId}`}
      className="min-w-0 rounded-md border bg-background"
    >
      <header className="flex min-w-0 flex-col gap-2 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={`overview-pool-${pool.poolId}`} className="truncate text-base font-semibold">
            {pool.name}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("overview.pools.summary", {
              requests: formatCount(locale, pool.current.requests),
              errors: formatCount(locale, pool.current.errors),
              cache,
            })}
          </p>
        </div>
        <Link
          to="/$lang/dashboard/pools/$poolId"
          params={{ lang, poolId: pool.poolId }}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "min-h-[44px] shrink-0 self-start",
          )}
        >
          {t("overview.pools.open")}
          <ArrowRight aria-hidden="true" />
        </Link>
      </header>

      <div className="min-w-0 p-4">
        {pool.current.requests === 0 ? (
          <p
            className="flex items-center justify-center text-sm text-muted-foreground"
            style={{ height: CHART_HEIGHT_PX }}
          >
            {t("overview.pools.noTraffic")}
          </p>
        ) : (
          <figure className="m-0 min-w-0">
            <figcaption className="sr-only">
              {t("overview.pools.chartLabel", { name: pool.name })}
            </figcaption>
            <ChartContainer
              config={config}
              className="aspect-auto w-full"
              style={{ height: CHART_HEIGHT_PX }}
              initialDimension={{ width: 640, height: CHART_HEIGHT_PX }}
            >
              <AreaChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucketStart"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                  tickFormatter={(value: string) => tickTime(locale, range, value)}
                />
                <YAxis
                  width={40}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals
                  tickFormatter={(value: number) => formatCount(locale, value)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, payload) => {
                        const iso = payload?.[0]?.payload?.bucketStart;
                        return typeof iso === "string"
                          ? `${tickTime(locale, range, iso)} · ${t("overview.pools.perMinute")}`
                          : "";
                      }}
                    />
                  }
                />
                {series.map((entry) => (
                  <Area
                    key={entry.key}
                    dataKey={entry.key}
                    type="monotone"
                    stackId="requests"
                    stroke={`var(--color-${entry.key})`}
                    fill={`var(--color-${entry.key})`}
                    fillOpacity={0.35}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          </figure>
        )}

        <WideContent className="mt-4">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("overview.pools.columns.member")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("overview.pools.columns.share")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("overview.pools.columns.cache")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  {t("overview.pools.columns.p50")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  {t("overview.pools.columns.p95")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  {t("overview.pools.columns.errors")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("overview.pools.columns.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pool.members.map((member, index) => {
                const label = memberLabel(member, t);
                const seriesEntry = series.find((entry) =>
                  entry.seriesKeys.includes(member.seriesKey),
                );
                return (
                  <tr
                    key={member.seriesKey || `unrouted-${index}`}
                    className="border-b last:border-0"
                  >
                    <td className="max-w-64 py-2 pr-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0"
                          style={{
                            background: seriesEntry
                              ? `var(--chart-${seriesEntry.colorSlot})`
                              : "transparent",
                          }}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{label.primary}</div>
                          {label.secondary ? (
                            <div className="truncate text-xs text-muted-foreground">
                              {label.secondary}
                              {member.tier ? ` · ${t(`overview.pools.tier.${member.tier}`)}` : ""}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <InlineBar
                        value={member.share}
                        label={
                          member.share === null
                            ? t("overview.noValue")
                            : formatPercent(locale, member.share)
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      {member.stats.cacheHitRate === null ? (
                        <span className="text-muted-foreground">{t("overview.notReported")}</span>
                      ) : (
                        <InlineBar
                          value={member.stats.cacheHitRate}
                          label={formatPercent(locale, member.stats.cacheHitRate)}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {member.stats.p50LatencyMs === null
                        ? t("overview.noValue")
                        : formatDuration(locale, member.stats.p50LatencyMs)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {member.stats.p95LatencyMs === null
                        ? t("overview.noValue")
                        : formatDuration(locale, member.stats.p95LatencyMs)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {member.stats.errorRate === null
                        ? t("overview.noValue")
                        : formatPercent(locale, member.stats.errorRate)}
                    </td>
                    <td className="py-2 text-xs">
                      {member.healthStatus ? (
                        <span>
                          {t(`overview.pools.health.${member.healthStatus}`)}
                          {member.routingStatus && member.routingStatus !== "ACTIVE"
                            ? ` · ${t(`overview.pools.routing.${member.routingStatus}`)}`
                            : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("overview.noValue")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </WideContent>
      </div>
    </section>
  );
}
