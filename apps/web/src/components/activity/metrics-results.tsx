import type { Metric } from "@ws-model-proxy/api/contracts/metrics";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { type ComponentProps, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import { WideContent } from "@/components/wide-content";

import {
  type ChartRow,
  formatMetricValue,
  isCustomMetric,
  type MetricStep,
} from "@/lib/activity-metrics";
import { dateTimeFormat } from "@/lib/intl-format";

/** One line of the chart and one column of the table. */
export type MetricsColumn = { key: string; label: string };

/** A metric's localized name (`custom:<name>` metrics are shown as named on the node). */
export function useMetricLabel(): (metric: Metric) => string {
  const { t } = useTranslation(["activity"]);
  return (metric) =>
    isCustomMetric(metric) ? metric : t(`activity:metrics.metricValue.${metric}`);
}

export function useMetricFormatter(): (metric: Metric, value: number) => string {
  const { t, i18n } = useTranslation(["activity"]);
  return (metric, value) =>
    formatMetricValue(metric, value, i18n.language, (shown) =>
      t("activity:metrics.tokensPerSecond", { value: shown }),
    );
}

// Day buckets start at UTC midnight (steps count from the epoch): label them in UTC so they do
// not read as the day before west of Greenwich.
const DAY_LABEL: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
const TIME_LABEL: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

export function useTimeFormatter(step: MetricStep): (time: number) => string {
  const { i18n } = useTranslation();
  const format = dateTimeFormat(i18n.language, step === "1d" ? DAY_LABEL : TIME_LABEL);
  return (time) => format.format(time);
}

/** The chart, loaded on first use: Recharts is large and only this view needs it. */
const LazyMetricsChart = lazy(() =>
  import("./metrics-chart").then((module) => ({ default: module.MetricsChart })),
);

export function MetricsChart(props: ComponentProps<typeof LazyMetricsChart>) {
  return (
    <Suspense fallback={<Skeleton aria-hidden="true" className="h-64 w-full sm:h-80" />}>
      <LazyMetricsChart {...props} />
    </Suspense>
  );
}

export function MetricsTable({
  rows,
  columns,
  metric,
  step,
}: {
  rows: readonly ChartRow[];
  columns: readonly MetricsColumn[];
  metric: Metric;
  step: MetricStep;
}) {
  const { t } = useTranslation(["activity"]);
  const label = useMetricLabel();
  const formatValue = useMetricFormatter();
  const formatTime = useTimeFormatter(step);
  const shown = rows.filter((row) => columns.some((column) => row[column.key] != null));
  return (
    <WideContent>
      <table className="w-full min-w-max text-sm">
        <caption className="sr-only">{label(metric)}</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              {t("activity:metrics.time")}
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="py-2 pr-4 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.at} className="border-b last:border-b-0">
              <th scope="row" className="py-2 pr-4 text-left font-normal whitespace-nowrap">
                {formatTime(row.time)}
              </th>
              {columns.map((column) => {
                const value = row[column.key];
                return (
                  <td key={column.key} className="py-2 pr-4 text-right tabular-nums">
                    {typeof value === "number" ? formatValue(metric, value) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </WideContent>
  );
}

/** The window's totals, chart metric first. */
export function MetricsTotals({
  metrics,
  totals,
}: {
  metrics: readonly Metric[];
  totals: Record<string, number>;
}) {
  const { t } = useTranslation(["activity"]);
  const label = useMetricLabel();
  const formatValue = useMetricFormatter();
  return (
    <dl
      aria-label={t("activity:metrics.totals")}
      className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {metrics.map((metric) => {
        const value = totals[metric];
        return (
          <div key={metric} className="min-w-0 rounded-xl border bg-card p-3">
            <dt className="truncate text-xs text-muted-foreground">{label(metric)}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {value === undefined ? "—" : formatValue(metric, value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
