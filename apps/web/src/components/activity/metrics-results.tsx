import type { Metric } from "@ws-model-proxy/api/contracts/metrics";
import { type ChartConfig, ChartContainer } from "@ws-model-proxy/ui/components/chart";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import { WideContent } from "@/components/wide-content";
import {
  type ChartRow,
  formatMetricValue,
  isCustomMetric,
  type MetricStep,
} from "@/lib/activity-metrics";

/** One line of the chart and one column of the table. */
export type MetricsColumn = { key: string; label: string };

const PALETTE_SIZE = 8;

function colorOf(index: number): string {
  return `var(--chart-${(index % PALETTE_SIZE) + 1})`;
}

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

function useTimeFormatter(step: MetricStep): (time: number) => string {
  const { i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(
    i18n.language,
    // Day buckets start at UTC midnight (steps count from the epoch): label them in UTC so
    // they do not read as the day before west of Greenwich.
    step === "1d"
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
  return (time) => format.format(time);
}

export function MetricsChart({
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
  const config: ChartConfig = Object.fromEntries(
    columns.map((column, index) => [column.key, { label: column.label, color: colorOf(index) }]),
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WideContent>
        <ChartContainer
          config={config}
          role="img"
          aria-label={t("activity:metrics.chartLabel", {
            metric: label(metric),
            count: columns.length,
          })}
          className="aspect-auto h-64 w-full min-w-[480px] sm:h-80"
        >
          <LineChart
            data={[...rows]}
            // The table view is the accessible form; the chart stays an image.
            accessibilityLayer={false}
            margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatTime}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              tickFormatter={(value: number) => formatValue(metric, value)}
              tickLine={false}
              axisLine={false}
              width={72}
            />
            <Tooltip
              labelFormatter={(time) => (typeof time === "number" ? formatTime(time) : "")}
              formatter={(value, name) => [
                typeof value === "number" ? formatValue(metric, value) : "—",
                columns.find((column) => column.key === name)?.label ?? String(name),
              ]}
              contentStyle={{
                background: "var(--popover)",
                color: "var(--popover-foreground)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
              }}
            />
            {columns.map((column, index) => (
              <Line
                key={column.key}
                dataKey={column.key}
                name={column.key}
                type="monotone"
                stroke={`var(--color-${column.key})`}
                strokeDasharray={index >= PALETTE_SIZE ? "4 3" : undefined}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </WideContent>
      {columns.length > 1 ? (
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden="true">
          {columns.map((column, index) => (
            <li key={column.key} className="flex min-w-0 items-center gap-1.5">
              <svg viewBox="0 0 16 4" className="h-1 w-4 shrink-0" aria-hidden="true">
                <line
                  x1={0}
                  x2={16}
                  y1={2}
                  y2={2}
                  stroke={colorOf(index)}
                  strokeWidth={4}
                  strokeDasharray={index >= PALETTE_SIZE ? "4 3" : undefined}
                />
              </svg>
              <span className="min-w-0 break-all">{column.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The chart's values as a table: buckets with any value, one column per series. */
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
